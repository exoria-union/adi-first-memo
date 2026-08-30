#!/usr/bin/python3
# -*- coding: utf-8 -*-
"""
지역 탐사 / 동행 시스템.

- [지역/지역명/(스탯)/(포션)] → area_mission(...)
- [동행/지역명/동료1,동료2,...]   → with_companion(...)

설계 원칙
- 모든 cursor.fetchone() 결과는 None을 가정하고 방어 (KeyError/TypeError 발생 금지)
- 모든 area 컬럼 접근은 .get() + 안전 캐스팅 (_safe_int / _safe_str)
- 인카운터 유형별 로직을 함수 단위로 분리 (유지보수성)
- 외부 데이터(item_id, key_id, deal_item_id, item_drop) 는 _parse_id_list /
  _roll_dice_expr 를 통해 '잘못된 포맷도 죽지 않음'을 원칙으로 처리
- 예외 발생 시 사용자에겐 표준 안내 메시지, 로그에는 traceback 기록
"""
import hashlib
import logging
import random
import traceback
from datetime import datetime, time, date

from pyjosa.josa import Josa

from mastodon_bot_core import get_db_cursor, target_dice, random_dice
from mastodon_bot_encounter import enemy_encounter


# ==========================================
# 상수
# ==========================================
SYSTEM_ERROR_TEMPLATE = (
    "자동봇 오류가 발생하였습니다. 운영 계정에 DM을 부탁드립니다.\n"
    "오류가 발생한 시스템은 [{ctx}]입니다. @EXORIA"
)
GENERIC_AREA_NOT_FOUND = '{name_post} 임무를 수행할 수 있는 지역이 아닌 것 같다……. 지도를 확인해 보자.'
KEY_ITEM_MISSING_MSG = '필요한 키 아이템을 다 가지고 있지 않은 것 같다. 언제 흘렸나……? 다시 주머니를 확인해 보자.'
DEAL_ITEM_MISSING_MSG = '필요한 아이템을 다 가지고 있지 않은 것 같다. 언제 흘렸나……? 다시 주머니를 확인해 보자.'
HP_TOO_LOW_MSG = '지금 몸 상태로 임무에 나가는 것은 무리다……. 우선 체력부터 회복하고 보자.'

# 인카운터 분류 (DB의 incounter_cd 값)
INCOUNTER_TIME_NIGHT = 'INCUNTR_00_NIGHT'
INCOUNTER_TIME_DNIGHT = 'INCUNTR_00_DNIGHT'
INCOUNTER_PASS_THROUGH = {'INCUNTR_02', 'INCUNTR_00', INCOUNTER_TIME_NIGHT, INCOUNTER_TIME_DNIGHT}
INCOUNTER_TRADE_ITEM_GOLD = 'INCUNTR_04_IG'
INCOUNTER_TRADE_ITEM_ITEM = 'INCUNTR_04_II'
INCOUNTER_TRADE_GOLD_ITEM = 'INCUNTR_04_GI'
INCOUNTER_SKILL_CHECK = 'INCUNTR_03'
INCOUNTER_COMPLETE = 'INCUNTR_99'

# 종족 매핑 (open_race → ch_class)
RACE_TO_CH_CLASS = {'VAM': 3, 'CYC': 6, 'GAG': 5, 'BAN': 4}
HALF_HUMAN_CLASSES = {3, 4, 5, 6}  # H_ALL

# 포션 / 스탯
POTION_ITEM_IDS = {'힘': 99, '솜씨': 179, '지혜': 185}
STAT_COLUMN_BY_KOR = {'힘': 'str', '솜씨': 'diy', '지혜': 'wis'}
ALLOWED_STATS = ('힘', '솜씨', '지혜')

# 특수 아이템 (1개 소지 제한)
SINGLE_INSTANCE_ITEM_IDS = {282}

# 동행 / 일일 임무 제한
VATICAN_AREA_IDS = {'E_VATICAN_BAP'}

# 하루 탐사 블록 한도. 1 블록 = 1개의 up 지역(MAP) 탐사.
# INCUNTR_99 도달 시 해당 mission_result = 'SUCC' → 같은 날 한도 내라면 다음 up 지역 시작 가능.
#   솔로 [지역]      : 최대 1 블록
#   동행 [동행]      : 최대 2 블록
# VATICAN(E_VATICAN_BAP) 은 한도에 포함되지 않음(특수 면제).
SOLO_MAX_BLOCKS = 1
COMPANION_MAX_BLOCKS = 2
# 하위 호환 별칭 — 외부에서 참조하는 코드가 있을 수 있으므로 유지.
MAX_AREA_MISSION_PER_DAY = COMPANION_MAX_BLOCKS

# ============================================================
# 지역 선행 완료 게이트 (progression gate)
# ------------------------------------------------------------
# 특정 지역에 진입하려면, 지정된 '선행 지역'을 먼저 '완료(클리어, mission_result=
# 'SUCC')'해야 한다.
#   - 단일 단계 규칙(체인 아님): 각 지역은 '직속 선행 지역' 하나만 본다. 그 전에
#     어떤 지역을 어떤 순서로 들렀는지는 무관하다.
#   - 전 유저 공유: 누구든 한 명이 선행 지역을 클리어하면 모두에게 영구 개방된다.
#   key   = 진입하려는 지역명
#   value = 먼저 완료해야 하는 선행 지역명 (표시용; 메시지에 그대로 노출)
# 조회는 공백을 무시하므로(_prereq_for) 키/값을 '계시 성소' 처럼 공백 포함으로
# 적든 '계시성소' 로 적든 동일하게 동작한다. 선행 지역명은 _load_area_by_name 으로
# area_id 를 해석하므로 DB 의 area_name 과 (공백 무시) 일치해야 한다.
# 규칙: 리세움 안뜰 클리어 → 경당 개방, 경당 클리어 → 계시 성소 개방
#       (리세움 안뜰 자체는 선행 조건 없음)
# ============================================================
AREA_PREREQUISITES = {
    '경당': '리세움 안뜰',
    '계시 성소': '경당',
}


def _prereq_for(normalized_area):
    """공백 무시 선행 지역 조회. 맵 키에 공백이 있든 없든 매칭한다.

    (게이트는 공백 제거된 normalized_area 로 조회하는데, 맵 키가 '계시 성소' 처럼
    공백을 포함하면 단순 dict.get 은 미스가 나 게이트가 통째로 통과되는 버그가 있었다.)
    """
    if not normalized_area:
        return None
    key = str(normalized_area).replace(' ', '')
    for target, prereq in AREA_PREREQUISITES.items():
        if str(target).replace(' ', '') == key:
            return prereq
    return None

# ============================================================
# 진입 차단 지역 (entry-blocked areas)
# ------------------------------------------------------------
# 아직 들어갈 수 없도록 막아둔 지역. 공백 무시로 매칭하며, 진입 시도 시
# 안내 문구만 출력하고 임무 시작을 막는다(솔로 [지역]/[동행] 모두 적용).
# ============================================================
BLOCKED_AREAS = {
}


def _blocked_area_msg(normalized_area):
    """공백 무시로 진입 차단 지역인지 조회. 막힌 지역이면 안내 문구(str), 아니면 None."""
    if not normalized_area:
        return None
    key = str(normalized_area).replace(' ', '')
    for target, msg in BLOCKED_AREAS.items():
        if str(target).replace(' ', '') == key:
            return msg
    return None


# ============================================================
# 지역임무 시즌 / 주간 휴무 게이트 (운영 일정 기반 출입 제어)
# ------------------------------------------------------------
# 운영 규칙
#   - 지역임무는 '시즌' 단위로 열린다. 시즌은 시작 달의 '첫째 주 금요일'에 개막해
#     약 2개월간 진행하는 것이 기본 규칙이다.
#   - 이번 시즌: 2026-10-02(10월 첫째 주 금요일)에 개막 ~ 2026-12-31(12월 마지막 날)까지.
#   - 매주 '금요일'은 휴무일 — 지역임무 도전 불가.
#   - 단, 시즌 '개막일'(= AREA_SEASON_START, 이번엔 금요일)은 예외적으로 도전 가능.
#
# 다음 시즌으로 전환할 때는 아래 두 상수(AREA_SEASON_START/END)만 갱신하면 된다.
#   예) 시작 달의 첫째 주 금요일과, 그로부터 약 2개월 뒤 마지막 날짜를 넣는다.
#       (기본 규칙이 '2개월'이지만 이번 시즌은 12월 말일까지로 명시 지정됨 — 명시 날짜 우선)
# 솔로 [지역]과 [동행] 모두에 동일하게 적용된다(area_mission / with_companion 진입부).
# ============================================================
AREA_SEASON_START = date(2026, 8, 2)   # 시즌 개막일(10월 첫째 주 금요일) — 금요일이지만 도전 가능
AREA_SEASON_END = date(2026, 12, 31)    # 시즌 종료일(포함) — 이 날까지 도전 가능
_FRIDAY = 4                             # datetime.date.weekday(): 월=0, 화=1, ... 금=4, 일=6

# 안내 문구
AREA_OFF_SEASON_MSG = (
    '지금은 지역임무 기간이 아닌 것 같다……. 아직 개막하지 않았거나, 이번 지역임무가 '
    '이미 마무리된 모양이다. 다음 지역임무를 기다려 보자.'
)
AREA_REST_DAY_MSG = (
    '오늘은 지역임무를 쉬는 날이다. (매주 금요일 휴무)\n'
    '푹 쉬고, 다음 날 다시 지역임무에 도전해 보자.'
)


def _area_season_block_msg(today=None):
    """지역임무 시즌/휴무 게이트.

    도전 '불가'면 안내 문구(str)를, '가능'하면 None 을 반환한다.
      1) 시즌 기간 [AREA_SEASON_START, AREA_SEASON_END] 밖 → 차단(off-season).
      2) 기간 내라도 금요일 → 휴무 차단. 단, 개막일(AREA_SEASON_START)은 예외적으로 허용.
    today 는 테스트 주입용(기본 오늘 날짜). datetime/date 어느 쪽이 와도 date 로 정규화.
    """
    if today is None:
        today = datetime.now().date()
    elif isinstance(today, datetime):
        today = today.date()

    # 1) 시즌 기간 밖 (개막 전 또는 종료 후)
    if today < AREA_SEASON_START or today > AREA_SEASON_END:
        return AREA_OFF_SEASON_MSG

    # 2) 개막일은 금요일이어도 예외적으로 허용
    if today == AREA_SEASON_START:
        return None

    # 3) 기간 내 금요일 = 휴무
    if today.weekday() == _FRIDAY:
        return AREA_REST_DAY_MSG

    return None


# ============================================================
# 지역별 이미지 첨부 매핑
# ------------------------------------------------------------
# 특정 area_id 의 지역에 진입 시 첨부할 이미지 파일명 (image/ 디렉터리).
# 디스패처(mastodon_bot.py)가 결과가 (msg, image) 튜플인 경우
# m.media_post() 로 업로드하여 답글에 첨부함.
# ============================================================
AREA_IMAGE_MAP = {
    'CHESELA_CHE_NAVE_20': 'Jbj.png',
}


def _maybe_attach_area_image(result, area):
    """area 의 area_id 가 이미지 매핑에 있으면 (result, image) 튜플로 변환.

    - result 가 비어있거나 이미 튜플이면 그대로 반환.
    - area 가 None 이거나 area_id 가 매핑에 없으면 그대로 반환.
    """
    if not result or not isinstance(result, str) or not area:
        return result
    image = AREA_IMAGE_MAP.get(area.get('area_id'))
    if image:
        return (result, image)
    return result


# ==========================================
# 안전한 캐스팅 / DB 헬퍼
# ==========================================
def _safe_int(val, default=0):
    """None / '' / 비숫자 → default."""
    if val is None or val == '':
        return default
    try:
        return int(val)
    except (ValueError, TypeError):
        return default


def _safe_str(val, default=''):
    if val is None:
        return default
    return str(val)


def _system_error(ctx):
    return SYSTEM_ERROR_TEMPLATE.format(ctx=ctx)


def _area_not_found_msg(area_name):
    try:
        post = Josa.get_full_string(area_name, "은")
    except Exception:
        post = f'{area_name}은(는)'
    return GENERIC_AREA_NOT_FOUND.format(name_post=post)


def _parse_id_list(raw):
    """'1,2,3' / '{1,2,3}' / '1' / None → [int,...]. 잘못된 항목은 건너뜀."""
    if raw is None:
        return []
    text = str(raw).strip().strip('{}').strip()
    if not text:
        return []
    result = []
    for piece in text.split(','):
        piece = piece.strip()
        if not piece:
            continue
        try:
            result.append(int(piece))
        except (ValueError, TypeError):
            continue
    return result


def _roll_dice_expr(expr, default=1):
    """
    '1D6' 굴림 결과 / 순수 정수 / 잘못된 포맷 모두 안전 처리.
    잘못된 포맷이면 default 반환.
    """
    if expr is None or expr == '':
        return default
    s = str(expr).upper().strip()
    if 'D' not in s:
        try:
            return int(s)
        except (ValueError, TypeError):
            return default
    parts = s.split('D')
    if len(parts) != 2 or not parts[0].isdigit() or not parts[1].isdigit():
        return default
    try:
        return random_dice(parts[0], parts[1])
    except Exception:
        return default


def _award_item(cursor, item_id, it_name, ch_id, ch_name, count=1):
    n = max(0, _safe_int(count, 1))
    for _ in range(n):
        cursor.execute(
            "INSERT INTO avo_inventory (it_id, it_name, ch_id, ch_name) VALUES (%s, %s, %s, %s)",
            [item_id, it_name, ch_id, ch_name])


def _lookup_item_name(cursor, item_id):
    cursor.execute("select it_name from avo_item where it_id = %s", [item_id])
    row = cursor.fetchone()
    if not row:
        return None
    return row.get('it_name')


def _consume_first_available(cursor, ch_id, item_ids):
    """item_ids 중 인벤토리에 있는 첫 아이템 1개를 소모. 성공 시 True."""
    for item_id in item_ids:
        cursor.execute(
            "select in_id from avo_inventory where it_id = %s and ch_id = %s "
            "order by in_id desc limit 1",
            [item_id, ch_id])
        inv = cursor.fetchone()
        if inv and 'in_id' in inv:
            cursor.execute("delete from avo_inventory where in_id = %s", [inv['in_id']])
            return True
    return False


def _load_character(cursor, user_id):
    cursor.execute("select * from bot_character where bot = %s", [user_id])
    return cursor.fetchone()


def _load_character_by_name(cursor, ch_name):
    cursor.execute("select * from bot_character where ch_name = %s", [ch_name])
    return cursor.fetchone()


def _load_area_by_name(cursor, normalized_name):
    cursor.execute(
        "select * from bot_area "
        "where REGEXP_REPLACE(area_name, ' ', '') = %s and use_yn = 'Y'",
        [normalized_name])
    return cursor.fetchone()


def _load_sub_area(cursor, normalized_name, parent_id, up_id):
    """진행 중 임무 컨텍스트의 sub area 조회.

    상위 지역(up_area_id) 으로 항상 스코프를 좁혀, 다른 MAP 의 동일 이름 지역으로
    잘못 이동하는 것을 차단한다. 즉 현재 임무의 1depth(up_area_id) 안에서만 sub area 매칭.

    - up_id 가 있을 때:
        · parent_id 도 있으면 (up_area_id = up_id) AND (parent_area_id = parent_id) 동시 충족
        · parent_id 가 없으면 up_area_id = up_id 만으로 좁힘
    - up_id 자체가 없으면 (legacy/예외 상황) parent_id 만으로 fallback — 단 둘 다 없으면 None
    """
    if not up_id and not parent_id:
        return None

    if up_id and parent_id:
        cursor.execute(
            "select * from bot_area where up_area_id = %s and parent_area_id = %s "
            "and REGEXP_REPLACE(area_name, ' ', '') = %s and use_yn = 'Y'",
            [up_id, parent_id, normalized_name])
    elif up_id:
        cursor.execute(
            "select * from bot_area where up_area_id = %s "
            "and REGEXP_REPLACE(area_name, ' ', '') = %s and use_yn = 'Y'",
            [up_id, normalized_name])
    else:
        # up_id 없음 — legacy data. parent_id 만으로 좁히되 경고 로그.
        logging.warning(
            f"_load_sub_area: up_area_id 누락 — parent_area_id 단독으로 조회 (name={normalized_name!r}, parent={parent_id!r})"
        )
        cursor.execute(
            "select * from bot_area where parent_area_id = %s "
            "and REGEXP_REPLACE(area_name, ' ', '') = %s and use_yn = 'Y'",
            [parent_id, normalized_name])
    return cursor.fetchone()


def _get_area_mission_cnt(cursor, ch_id):
    cursor.execute("select area_mission_cnt from bot_count where ch_id = %s", [ch_id])
    row = cursor.fetchone()
    if not row:
        return 0
    return _safe_int(row.get('area_mission_cnt'), 0)


def _area_no_consume(area):
    """이 지역 진입이 '지역임무 기회(블록 한도)'를 소모하지 않는지 여부.

    True 면 한도 검사와 카운트 증가를 모두 생략한다.
      - bot_area.no_consume_yn == 'Y'  (신규 컬럼, 기본 'N')  → 소모 안 함
      - 기존 VATICAN(E_VATICAN_BAP) 면제도 계속 유지          → 소모 안 함
    (migration_area_flags.sql 참조)
    """
    if not area:
        return False
    if _safe_str(area.get('no_consume_yn')).strip().upper() == 'Y':
        return True
    a_id = area.get('area_id')
    p_a_id = area.get('parent_area_id') or a_id
    return a_id in VATICAN_AREA_IDS or p_a_id in VATICAN_AREA_IDS


def _get_ch_gold(cursor, ch_id):
    """캐릭터 현재 골드 — bot_character 의 ch_gold 컬럼 사용 (음수/NULL 방어)."""
    cursor.execute("select ch_gold from bot_character where ch_id = %s", [ch_id])
    row = cursor.fetchone()
    if not row:
        return 0
    return _safe_int(row.get('ch_gold'), 0)


# ==========================================
# 첫 탐사 팀 게이트 — 동행 전원 통과 전까지 clear_yn 플립 지연
# ==========================================
def _record_area_visit(cursor, ch_id, area_id, mission_id=None):
    """(ch_id, area_id) 첫 방문 기록. 이미 있으면 INSERT IGNORE 로 무시."""
    if not ch_id or not area_id:
        return
    try:
        cursor.execute(
            "INSERT IGNORE INTO bot_area_visit (ch_id, area_id, mission_id, first_visit_dt) "
            "VALUES (%s, %s, %s, now())",
            [ch_id, area_id, mission_id])
    except Exception as e:
        logging.warning(f'bot_area_visit INSERT 실패(무시): {e}')


def _has_cleared_area(cursor, prereq_area):
    """'누구든' prereq_area(루트 지역)의 블록을 '완료(클리어, mission_result=SUCC)'한
    적 있는지. (전 유저 공유 — 한 명이 클리어하면 모두에게 영구 개방.)

    판정 키 = 미션의 area_id. 완료 시 area_id 는 INCUNTR_99 서브지역으로 보존되며,
    그 서브지역의 부모는 bot_area 에 정적으로 박혀 있다. 따라서 SUCC 미션의 area_id 가
    '루트 area_id' 또는 '부모가 루트인 서브지역' 집합에 속하면 그 블록을 클리어한 것.

    (미션의 parent_area_id 는 진행 중 변형될 수 있어 신뢰 불가 → 정적인 bot_area
     계층으로 매칭.) 영구 기준(날짜·캐릭터 무관). 실패 시 False.
    """
    if not prereq_area:
        return False
    root_id = prereq_area.get('parent_area_id') or prereq_area.get('area_id')
    if not root_id:
        return False
    try:
        cursor.execute(
            "select 1 from bot_area_mission "
            "where mission_result = 'SUCC' "
            "and area_id in ("
            "  select area_id from bot_area where area_id = %s or parent_area_id = %s"
            ") limit 1",
            [root_id, root_id])
        return cursor.fetchone() is not None
    except Exception as e:
        logging.warning(f'지역 완료(SUCC) 조회 실패(무시): {e}')
        return False


def _area_prerequisite_unmet(cursor, normalized_area):
    """normalized_area 진입의 선행 완료 조건이 (전 유저 통틀어) 안 채워졌으면 선행
    지역명(str), 충족/미등록/데이터없음이면 None 반환.

    AREA_PREREQUISITES 에 등록된 지역만 검사한다(단일 단계 — 체인 아님). 선행 지역이
    DB 에 없으면 소프트락을 막기 위해 통과(None) 처리하고 경고만 남긴다.
    """
    prereq_display = _prereq_for(normalized_area)
    if not prereq_display:
        return None
    prereq_area = _load_area_by_name(cursor, prereq_display.replace(' ', ''))
    if not prereq_area or not (prereq_area.get('parent_area_id') or prereq_area.get('area_id')):
        logging.warning(
            f'선행 지역 데이터 미발견 — 게이트 통과 처리 '
            f'(target={normalized_area!r}, prereq={prereq_display!r})')
        return None
    if _has_cleared_area(cursor, prereq_area):
        return None
    return prereq_display


def _prereq_block_msg(area_name, prereq_display):
    """선행 완료 게이트 차단 메시지."""
    try:
        prereq_josa = Josa.get_josa(prereq_display, "을")
    except Exception:
        prereq_josa = '을(를)'
    try:
        target_post = Josa.get_full_string(area_name, "에")
    except Exception:
        target_post = f'{area_name}에'
    return (f'{target_post} 가기 위해서는 먼저 [{prereq_display}]{prereq_josa} 탐사 완료해야 할 것 같다. '
            f'누군가 그곳을 밝혀내면 길이 열릴 것이다.')


def _check_area_prerequisite(cursor, normalized_area, area_name):
    """선행 완료 게이트(솔로 [지역] / [동행] 공통). 진입 가능하면 None, 막히면 안내(str).

    완료 기록은 전 유저 공유라 캐릭터 구분이 없다.
    """
    prereq_display = _area_prerequisite_unmet(cursor, normalized_area)
    if prereq_display:
        return _prereq_block_msg(area_name, prereq_display)
    return None


def _resolve_team_ch_ids(cursor, char, manage):
    """현재 캐릭터의 팀(self + companion_id 의 bot_id 들) → ch_id 리스트.
    솔로(companion_id 비어있음)면 [self_ch_id]."""
    self_id = char.get('ch_id') if char else None
    ids = [self_id] if self_id is not None else []
    comp_raw = (manage or {}).get('companion_id') or ''
    bot_ids = [b.strip() for b in str(comp_raw).split(',') if b.strip()]
    if not bot_ids:
        return ids
    placeholders = ','.join(['%s'] * len(bot_ids))
    cursor.execute(
        f"select ch_id from bot_character where bot in ({placeholders})",
        bot_ids)
    rows = cursor.fetchall() or []
    for r in rows:
        cid = r.get('ch_id') if isinstance(r, dict) else None
        if cid is not None and cid not in ids:
            ids.append(cid)
    return ids


def _get_or_set_first_team(cursor, area, char, manage):
    """area 의 first_team_ch_ids 가 비어있으면 현재 캐릭터의 팀으로 세팅 후 반환.
    이미 있으면 그 값 파싱하여 반환. ([] 도 가능)."""
    raw = (area or {}).get('first_team_ch_ids')
    if raw:
        return [int(x) for x in str(raw).split(',') if x.strip().lstrip('-').isdigit()]

    team = _resolve_team_ch_ids(cursor, char, manage)
    if not team:
        return []
    joined = ','.join(str(c) for c in team)
    try:
        cursor.execute(
            "update bot_area set first_team_ch_ids = %s, first_team_set_dt = now() "
            "where area_id = %s and (first_team_ch_ids is null or first_team_ch_ids = '')",
            [joined, area.get('area_id')])
    except Exception as e:
        logging.warning(f'first_team_ch_ids 세팅 실패(무시): {e}')
    return team


def _all_team_visited_or_failed(cursor, team_ch_ids, area_id):
    """팀원 전원이 area_id 방문 또는 (어제~오늘 윈도우) 미션 FAIL 종료 했는지."""
    if not team_ch_ids:
        return False
    placeholders = ','.join(['%s'] * len(team_ch_ids))
    cursor.execute(
        f"select distinct ch_id from bot_area_visit "
        f"where area_id = %s and ch_id in ({placeholders})",
        [area_id] + list(team_ch_ids))
    rows = cursor.fetchall() or []
    visited = {(r.get('ch_id') if isinstance(r, dict) else None) for r in rows}
    missing = [cid for cid in team_ch_ids if cid not in visited]
    if not missing:
        return True
    # 누락된 멤버의 FAIL 종료 확인 (양일 윈도우)
    placeholders2 = ','.join(['%s'] * len(missing))
    cursor.execute(
        f"select distinct ch_id from bot_area_mission "
        f"where ch_id in ({placeholders2}) "
        f"and date(start_dt) >= date_sub(curdate(), interval 1 day) "
        f"and mission_result = 'FAIL'",
        list(missing))
    rows = cursor.fetchall() or []
    failed = {(r.get('ch_id') if isinstance(r, dict) else None) for r in rows}
    still_missing = [cid for cid in missing if cid not in failed]
    return not still_missing


def _is_area_cleared(cursor, area_or_id):
    """지역의 '첫 탐사 완료' 여부 통합 조회.

    area_or_id 가 dict 면 in-memory clear_yn 우선 (current transaction 의 최신값을
    이미 가지고 있을 가능성). str 이면 DB 에서 SELECT.
    """
    if area_or_id is None:
        return False
    if isinstance(area_or_id, dict):
        return area_or_id.get('clear_yn') == 'Y'
    try:
        cursor.execute(
            "select clear_yn from bot_area where area_id = %s limit 1",
            [area_or_id])
        row = cursor.fetchone()
    except Exception as e:
        logging.warning(f'_is_area_cleared 조회 실패: {e}')
        return False
    return bool(row and row.get('clear_yn') == 'Y')


def verify_team_visited_area(cursor, ch_ids, area_id):
    """공개 헬퍼 — 주어진 ch_id 들이 area_id 를 모두 방문했는지 검증.

    사후 검증(보상 분배, 동행 정합성 점검) 등에 사용. FAIL 종료는 인정하지 않음
    (보상 자격 검증에는 '실제로 같이 다녔는가' 가 핵심이라 엄격).
    """
    if not ch_ids or not area_id:
        return False
    placeholders = ','.join(['%s'] * len(ch_ids))
    cursor.execute(
        f"select distinct ch_id from bot_area_visit "
        f"where area_id = %s and ch_id in ({placeholders})",
        [area_id] + list(ch_ids))
    rows = cursor.fetchall() or []
    visited = {(r.get('ch_id') if isinstance(r, dict) else None) for r in rows}
    return all(cid in visited for cid in ch_ids)


def _maybe_flip_area_cleared(cursor, char, manage, area):
    """동행 첫 탐사 팀 전원이 area 를 방문/이탈 했을 때만 clear_yn='Y' 플립.

    동작:
      1) area.clear_yn 이미 'Y' → no-op
      2) 현재 진입자 방문 기록 (멱등)
      3) 첫 팀(first_team_ch_ids) 결정/조회 — 솔로 첫 진입이면 자기 자신 1명
      4) 첫 팀 전원이 방문/FAIL → clear_yn = 'Y' UPDATE
    """
    if not area or not char:
        return
    area_id = area.get('area_id')
    if not area_id:
        return
    if area.get('clear_yn') == 'Y':
        return

    _record_area_visit(cursor, char.get('ch_id'), area_id,
                       (manage or {}).get('mission_id'))

    first_team = _get_or_set_first_team(cursor, area, char, manage)
    if not first_team:
        return

    if _all_team_visited_or_failed(cursor, first_team, area_id):
        cursor.execute(
            "update bot_area set clear_yn = 'Y' where area_id = %s", [area_id])


def _has_received_drop(cursor, ch_id, area_id):
    """ch_id 가 area_id 의 첫 탐사 아이템을 이미 받았는지(멤버별 1회 멱등 판정)."""
    if not ch_id or not area_id:
        return False
    cursor.execute(
        "select drop_granted_yn from bot_area_visit where ch_id = %s and area_id = %s limit 1",
        [ch_id, area_id])
    row = cursor.fetchone()
    return bool(row and row.get('drop_granted_yn') == 'Y')


def _mark_drop_granted(cursor, ch_id, area_id):
    """첫 탐사 아이템 지급 완료 멱등 마킹. bot_area_visit 행이 없으면 생성한다."""
    if not ch_id or not area_id:
        return
    try:
        cursor.execute(
            "INSERT INTO bot_area_visit (ch_id, area_id, drop_granted_yn, first_visit_dt) "
            "VALUES (%s, %s, 'Y', now()) "
            "ON DUPLICATE KEY UPDATE drop_granted_yn = 'Y'",
            [ch_id, area_id])
    except Exception as e:
        logging.warning(f'drop_granted 마킹 실패(무시): {e}')


def _is_first_explore_recipient(cursor, area, ch_id, char, manage):
    """ch_id 가 area 의 '첫 탐사 자격자'인지 — 첫 팀 멤버이면서 아직 미수령.

    first_team_ch_ids 가 비어 있으면 현재 캐릭터(팀)로 세팅된다(_get_or_set_first_team).
    clear_yn 과 무관하게, 멤버별 도착 시점에 1회 지급을 보장하기 위한 게이트.
    """
    area_id = area.get('area_id')
    if not ch_id or not area_id:
        return False
    team = _get_or_set_first_team(cursor, area, char, manage)
    if team and ch_id not in team:
        return False
    return not _has_received_drop(cursor, ch_id, area_id)


# ==========================================
# 출입 제약 / 키 아이템 / 포션
# ==========================================
def check_time_limit(area):
    """지역의 시간/날짜 출입 제한. (ok, error_msg)"""
    if not area:
        return True, ''
    incounter_cd = area.get('incounter_cd')
    now = datetime.now()
    c_time = now.time()

    if incounter_cd == INCOUNTER_TIME_NIGHT:
        if not (c_time >= time(18, 0) or c_time <= time(6, 0)):
            return False, '이곳은 오후 18시 00분부터 오전 06시 00분까지만 탐사할 수 있다. 다음에 다시 찾아와 보자….'

    elif incounter_cd == INCOUNTER_TIME_DNIGHT:
        day = now.day
        if not (19 <= day <= 21 and time(21, 0) <= c_time <= time(23, 0)):
            return False, '이곳은 2월 19일부터 2월 21일 사이, 오후 9시 00분부터 오후 11시 00분까지만 탐사할 수 있다. 다음에 다시 찾아와 보자….'

    return True, ''


def consume_key_items(cursor, ch_id, area):
    """키 아이템 확인 & 소모. area가 None이면 통과(상위에서 area null 검증 책임)."""
    if not area or area.get('key_yn') != 'Y':
        return True, ''

    raw = _safe_str(area.get('key_id'))
    is_or_condition = '{' in raw or '}' in raw
    key_ids = _parse_id_list(raw)
    if not key_ids:
        return True, ''

    if is_or_condition:
        if not _consume_first_available(cursor, ch_id, key_ids):
            return False, KEY_ITEM_MISSING_MSG
    else:
        # AND: 전부 있어야 하므로 먼저 모두 조회 후 일괄 삭제
        to_delete = []
        for key_id in key_ids:
            cursor.execute(
                "select in_id from avo_inventory where it_id = %s and ch_id = %s "
                "order by in_id desc limit 1",
                [key_id, ch_id])
            inv = cursor.fetchone()
            if not inv:
                return False, KEY_ITEM_MISSING_MSG
            to_delete.append(inv['in_id'])
        for in_id in to_delete:
            cursor.execute("delete from avo_inventory where in_id = %s", [in_id])

    # 지역 개방 처리
    parent_id = area.get('parent_area_id') or area.get('area_id')
    if parent_id and area.get('area_id'):
        cursor.execute(
            "update bot_area set open_yn = 'Y' where area_id = %s or parent_area_id = %s",
            [area['area_id'], parent_id])
    return True, ''


def _party_key_missing_msg(cursor, ch_id):
    """파티원 중 키 아이템 미보유자를 지목하는 안내 문구."""
    name = None
    try:
        cursor.execute("select ch_name from bot_character where ch_id = %s", [ch_id])
        row = cursor.fetchone()
        name = row.get('ch_name') if row else None
    except Exception:
        name = None
    if not name:
        return KEY_ITEM_MISSING_MSG
    try:
        post = Josa.get_full_string(name, "이")
    except Exception:
        post = f'{name}이(가)'
    return (f'{post} 필요한 키 아이템을 가지고 있지 않은 것 같다. '
            f'이 지역은 파티원 전원이 키 아이템을 갖춰야 함께 들어갈 수 있다.')


def _consume_party_key_items(cursor, member_ch_ids, area, opener_ch_id):
    """동행(파티) 키 아이템 처리.

    area.key_all_yn (기본 'Y') 에 따라 분기한다 (migration_area_flags.sql):
      - 'Y'(기본): 파티원 전원이 키 아이템을 보유했는지 먼저 모두 검사하고, 전원의 것을
                   일괄 소모한다. 한 명이라도 없으면 '아무도' 소모하지 않고 차단(원자적).
      - 'N'     : 대표(opener_ch_id) 한 명만 검사/소모 (기존 consume_key_items 동작).
    key_yn != 'Y' 이면 통과. 성공 시 지역 개방(open_yn='Y')은 1회만 수행.
    반환: (ok: bool, msg: str)

    ※ key_id 의 '{...}' 표기는 OR 조건(후보 중 아무거나 1개), 그 외는 AND(전부 필요).
    """
    if not area or area.get('key_yn') != 'Y':
        return True, ''

    key_all = _safe_str(area.get('key_all_yn'), 'Y').strip().upper() != 'N'  # 기본 Y
    if not key_all:
        # N — 대표 한 명만 (기존 동작 그대로 재사용)
        return consume_key_items(cursor, opener_ch_id, area)

    raw = _safe_str(area.get('key_id'))
    is_or_condition = '{' in raw or '}' in raw
    key_ids = _parse_id_list(raw)
    if not key_ids:
        return True, ''

    # 1) 전원 보유 검사 + 소모할 in_id 수집 (누구 하나라도 없으면 아무도 소모하지 않음)
    to_delete = []
    for m_ch_id in member_ch_ids:
        if is_or_condition:
            # OR: 후보 중 하나라도 있으면 그 하나를 소모 대상으로
            found = None
            for key_id in key_ids:
                cursor.execute(
                    "select in_id from avo_inventory where it_id = %s and ch_id = %s "
                    "order by in_id desc limit 1",
                    [key_id, m_ch_id])
                inv = cursor.fetchone()
                if inv:
                    found = inv['in_id']
                    break
            if found is None:
                return False, _party_key_missing_msg(cursor, m_ch_id)
            to_delete.append(found)
        else:
            # AND: 모든 key_id 를 각자 보유해야
            for key_id in key_ids:
                cursor.execute(
                    "select in_id from avo_inventory where it_id = %s and ch_id = %s "
                    "order by in_id desc limit 1",
                    [key_id, m_ch_id])
                inv = cursor.fetchone()
                if not inv:
                    return False, _party_key_missing_msg(cursor, m_ch_id)
                to_delete.append(inv['in_id'])

    # 2) 전원 확인 완료 → 일괄 소모
    for in_id in to_delete:
        cursor.execute("delete from avo_inventory where in_id = %s", [in_id])

    # 3) 지역 개방 (1회)
    parent_id = area.get('parent_area_id') or area.get('area_id')
    if parent_id and area.get('area_id'):
        cursor.execute(
            "update bot_area set open_yn = 'Y' where area_id = %s or parent_area_id = %s",
            [area['area_id'], parent_id])
    return True, ''


def consume_potion(cursor, ch_id, stat_val, stat_name):
    """스탯 강화 포션 소모."""
    if _safe_int(stat_val, 0) == 3:
        return False, '강화 포션을 사용할 필요는 없을 것 같다. 포션 없이 자신의 능력으로 도전해 보자.'

    item_id = POTION_ITEM_IDS.get(stat_name)
    if not item_id:
        return False, f'{stat_name} 강화 포션을 가지고 있지 않은 것 같다. 언제 다 써버렸나……? 다시 주머니를 확인해 보자.'

    cursor.execute(
        "select in_id from avo_inventory where it_id = %s and ch_id = %s "
        "order by in_id desc limit 1",
        [item_id, ch_id])
    inv = cursor.fetchone()
    if not inv:
        return False, f'{stat_name} 강화 포션을 가지고 있지 않은 것 같다. 언제 다 써버렸나……? 다시 주머니를 확인해 보자.'

    cursor.execute("delete from avo_inventory where in_id = %s", [inv['in_id']])
    return True, ''


# ==========================================
# 인카운터 핸들러 (각자 area_mission 진행 중 분기의 한 케이스를 담당)
# ==========================================
def _handle_giveup(cursor, char, manage):
    """[지역/포기] 처리."""
    ch_id = char['ch_id']
    ch_name = char['ch_name']
    ch_exp = _safe_int(char.get('ch_exp'), 0) + 5

    cursor.execute(
        "insert into avo_exp (ch_id, ch_name, ex_datetime, ex_content, ex_point, ex_ch_exp, ex_rel_action) "
        "values (%s, %s, now(), '지역 임무 탐사 실패 보상', 5, %s, '획득')",
        [ch_id, ch_name, ch_exp])
    cursor.execute("update avo_character set ch_exp = %s where ch_id = %s", [ch_exp, ch_id])
    cursor.execute(
        "update bot_mission_manage set end_dt = now(), end_cd = 'FAIL', "
        "choose_reward = 'Exp' where mission_id = %s",
        [manage['mission_id']])

    try:
        ch_post = Josa.get_full_string(ch_name, "이")
    except Exception:
        ch_post = f'{ch_name}이(가)'

    return (
        f'지역 임무를 포기하고 돌아가기로 했다.\n'
        f'실패는 성공의 어머니다. 적게나마 경험이 쌓였으니, 이제 교단으로 복귀하여 푹 쉬자.\n\n'
        f'지역 임무를 하면서 5시간의 경험이 쌓였다.\n'
        f'지금까지 {ch_post} 쌓은 경험은 {ch_exp}시간 정도다.'
    )


def _handle_passthrough(cursor, char, area, manage=None):
    """INCUNTR_02 / INCUNTR_00 계열: 통과형 인카운터."""
    _maybe_flip_area_cleared(cursor, char, manage, area)
    return extract_cn(cursor, char, area, '', manage=manage)


def _handle_trade_item_to_gold(cursor, char, area):
    """INCUNTR_04_IG: 아이템을 골드로 교환."""
    deal_ids = _parse_id_list(area.get('deal_item_id'))
    if not deal_ids:
        return DEAL_ITEM_MISSING_MSG
    if not _consume_first_available(cursor, char['ch_id'], deal_ids):
        return DEAL_ITEM_MISSING_MSG

    gold_drop = _safe_int(area.get('gold_drop'), 0)
    new_gold = _get_ch_gold(cursor, char['ch_id']) + gold_drop
    mb_id = char.get('mb_id')
    if mb_id is not None:
        cursor.execute(
            "insert into avo_point (mb_id, po_datetime, po_content, po_point, po_mb_point) "
            "values (%s, now(), '지역 임무 물물거래', %s, %s)",
            [mb_id, gold_drop, new_gold])
        cursor.execute("update avo_member set mb_point = %s where ch_id = %s",
                       [new_gold, char['ch_id']])
    return extract_cn(cursor, char, area, '')


def _handle_trade_item_to_item(cursor, char, area):
    """INCUNTR_04_II: 아이템을 다른 아이템으로 교환."""
    deal_ids = _parse_id_list(area.get('deal_item_id'))
    if not deal_ids:
        return DEAL_ITEM_MISSING_MSG
    if not _consume_first_available(cursor, char['ch_id'], deal_ids):
        return DEAL_ITEM_MISSING_MSG

    new_item_ids = _parse_id_list(area.get('item_id'))
    if not new_item_ids:
        # 받을 아이템이 없으면 그냥 텍스트만
        return extract_cn(cursor, char, area, '')

    safe_item_id = new_item_ids[0]
    it_name = _lookup_item_name(cursor, safe_item_id)
    if it_name is None:
        return extract_cn(cursor, char, area, '')

    drop_count = _roll_dice_expr(area.get('item_drop', 1), default=1)
    _award_item(cursor, safe_item_id, it_name, char['ch_id'], char['ch_name'], drop_count)

    # extract_cn에서 다시 아이템을 줄까봐 None 처리
    area = dict(area)
    area['item_id'] = None
    return extract_cn(cursor, char, area, '')


def _handle_trade_gold_to_item(cursor, char, area):
    """INCUNTR_04_GI: 골드를 지불하고 아이템 획득."""
    ch_gold = _get_ch_gold(cursor, char['ch_id'])
    deal_gold = _safe_int(area.get('deal_gold'), 0)

    if ch_gold < deal_gold:
        return '상인이 흥정은 어렵다며 내쫓았다……. 충분한 골드를 챙긴 다음 다시 오자.'

    new_gold = ch_gold - deal_gold
    mb_id = char.get('mb_id')
    if mb_id is not None:
        cursor.execute(
            "insert into avo_point (mb_id, po_datetime, po_content, po_point, po_mb_point) "
            "values (%s, now(), '지역 물물거래', %s, %s)",
            [mb_id, -deal_gold, new_gold])
        cursor.execute("update avo_member set mb_point = %s where ch_id = %s",
                       [new_gold, char['ch_id']])

    new_item_ids = _parse_id_list(area.get('item_id'))
    if new_item_ids:
        safe_item_id = new_item_ids[0]
        it_name = _lookup_item_name(cursor, safe_item_id)
        if it_name is not None:
            drop_count = _safe_int(area.get('item_drop', 1), 1)
            _award_item(cursor, safe_item_id, it_name, char['ch_id'], char['ch_name'], drop_count)

    area = dict(area)
    area['item_id'] = None
    return extract_cn(cursor, char, area, '')


def _required_stats_from_code(inc_cd):
    """INCUNTR_03_STR_WIS 등에서 필요 스탯 추출."""
    s = _safe_str(inc_cd).upper()
    names = []
    if 'STR' in s: names.append('힘')
    if 'WIS' in s: names.append('지혜')
    if 'DEX' in s: names.append('솜씨')
    if 'ALL' in s: names.append('무관')
    return names


def _handle_skill_check(cursor, char, area, area_action, potion, user_id, area_name, manage):
    """INCUNTR_03: 능력 판정."""
    inc_cd = _safe_str(area.get('incounter_cd'))
    status_names = _required_stats_from_code(inc_cd)
    m_id = manage['mission_id']
    u_a_id = manage.get('up_area_id')
    p_a_id = manage.get('parent_area_id')

    if area_action not in ALLOWED_STATS:
        if area.get('area_cn'):
            return extract_cn(cursor, char, area, '', manage=manage)
        req = status_names[0] if status_names else '원하는 스탯'
        return f'이곳을 통과하려면 능력을 발휘해야 할 것 같다. [지역/{area_name}/{req}]을 입력해 도전해 보자.'

    if '무관' not in status_names and area_action not in status_names:
        if not status_names:
            return f'이 행동은 통하지 않을 것 같다! 다른 방식으로 도전해 보자.'
        try:
            req_post = Josa.get_full_string(status_names[0], "을")
        except Exception:
            req_post = f'{status_names[0]}을(를)'
        return (
            f'이 행동은 통하지 않을 것 같다! 침착하게, 다른 방식으로 도전해 보자.\n'
            f' 가령, {req_post} 살린다면 어떨까?\n\n'
            f'▶[지역/{area_name}/{status_names[0]}]'
        )

    # 포션 사용
    if potion == '포션':
        stat_col = STAT_COLUMN_BY_KOR.get(area_action)
        stat_val = _safe_int(char.get(stat_col), 0) if stat_col else 0
        suc, msg = consume_potion(cursor, char['ch_id'], stat_val, area_action)
        if not suc:
            return msg

    # 주사위 판정
    target_val = _safe_int(area.get('target_roll'), 0)
    res = target_dice(user_id, area_action, target_val, 'Y' if potion == '포션' else 'N')
    keyword_row = f'({res["stat"]}D6>={res["target"]}) ＞ {res["dice_result"]}\n'

    open_roll = _safe_int(area.get('open_roll'), 0)
    open_roll_cnt = _safe_int(area.get('open_roll_cnt'), 0) + 1

    if res['good']:
        if open_roll == 0 or open_roll <= open_roll_cnt:
            keyword_row += extract_cn(cursor, char, area, 'succ')
            _maybe_flip_area_cleared(cursor, char, manage, area)

            area_exp = _safe_int(area.get('area_exp'), 0)
            if area_exp > 0:
                new_exp = _safe_int(char.get('ch_exp'), 0) + area_exp
                cursor.execute(
                    "insert into avo_exp (ch_id, ch_name, ex_datetime, ex_content, ex_point, ex_ch_exp, ex_rel_action) "
                    "values (%s, %s, now(), '지역 임무 탐사 보상', %s, %s, '획득')",
                    [char['ch_id'], char['ch_name'], area_exp, new_exp])
        else:
            keyword_row += '조금만 더 하면 될 것 같은데…? 다른 교단원에게 도움을 요청해 보자.'
            cursor.execute("update bot_area set open_roll_cnt = %s where area_id = %s",
                           [open_roll_cnt, area['area_id']])
    else:
        keyword_row += extract_cn(cursor, char, area, 'fail')
        cursor.execute(
            "update bot_mission_manage set up_area_id = %s, parent_area_id = %s, area_id = %s, "
            "last_dt = now(), end_dt = now(), end_cd = 'FAIL', mission_result = 'FAIL' "
            "where mission_id = %s",
            [u_a_id, p_a_id, area['area_id'], m_id])

    return keyword_row


def _handle_completion(cursor, char, area, manage):
    """INCUNTR_99: 임무 완료."""
    m_id = manage['mission_id']
    _maybe_flip_area_cleared(cursor, char, manage, area)
    cursor.execute(
        "update bot_mission_manage set end_dt = now(), end_cd = 'SUCC', "
        "mission_result = 'SUCC', choose_reward = 'Exp' where mission_id = %s",
        [m_id])

    # 인접 지역 개방
    adjacent_raw = area.get('adjacent_id')
    if adjacent_raw:
        for adj in str(adjacent_raw).split(','):
            adj = adj.strip()
            if not adj:
                continue
            # key_yn 컬럼은 비-키 지역에 'N' 이 아니라 '' (빈 문자열) 을 쓴다.
            # 따라서 key_yn = 'N' 으로 거르면 매칭되는 행이 0개가 되어 인접 지역이
            # 영영 열리지 않는다(솔로/동행 공통 버그). 키 게이트 지역(key_yn='Y')만
            # 제외하고 나머지 인접 지역을 모두 개방한다.
            cursor.execute(
                "update bot_area set open_yn = 'Y' "
                "where coalesce(key_yn, '') != 'Y' and use_yn = 'Y' "
                "and (parent_area_id = %s or area_id = %s)",
                [adj, adj])

    ch_id, ch_name = char['ch_id'], char['ch_name']
    ch_exp = _safe_int(char.get('ch_exp'), 0) + 10

    cursor.execute(
        "insert into avo_exp (ch_id, ch_name, ex_datetime, ex_content, ex_point, ex_ch_exp, ex_rel_action) "
        "values (%s, %s, now(), '지역 임무 탐사 완료 보상', 10, %s, '획득')",
        [ch_id, ch_name, ch_exp])
    cursor.execute("update avo_character set ch_exp = %s where ch_id = %s", [ch_exp, ch_id])

    keyword_row = extract_cn(cursor, char, area, '', manage=manage)

    try:
        ch_post = Josa.get_full_string(ch_name, "이")
    except Exception:
        ch_post = f'{ch_name}이(가)'

    return (
        f'{keyword_row}\n\n'
        f'짧은 시간에 많은 경험이 쌓였다. 이제 교단으로 복귀하여 푹 쉬자. '
        f'동행 중이라면 최대 2블록 탐사할 수 있다.\n\n'
        f'지역 임무를 하면서 10시간의 경험이 쌓였다.\n'
        f'지금까지 {ch_post} 쌓은 경험은 {ch_exp}시간 정도다.'
    )


# ============================================================
# 배타적 갈림길(분기 확정) — 진입 후 되돌아가기/샛길 차단
# ------------------------------------------------------------
# 한 블록(지역) 안의 갈림길에서, 선택지 노드 여러 개를 같은 branch_group 으로 묶으면
# 탐사 1회분 동안 '그 그룹의 한 노드에 진입하는 순간' 선택이 확정된다. 이후 같은
# 그룹의 '다른' 노드로는 진입할 수 없다(A로 들어간 뒤 돌아가 B로 새로 진입 불가).
#   - branch_group 이 비어있는 노드(=기존 전부)는 무영향 — 순수 opt-in.
#   - 잠금 범위(run_key): 솔로는 미션 단위, 동행은 '팀+블록+날짜' 해시로 팀 전원이 공유.
#   - 같은 노드 재진입은 허용(형제만 잠금). '재실행까지 금지'가 필요하면 별도 원장으로 확장.
# 강제 지점은 _handle_ongoing_mission 한 곳뿐(모든 블록 내 이동이 여기를 지난다).
# ============================================================
def _branch_run_key(manage):
    """이 탐사 회차의 분기 원장 키.

    동행이면 팀 bot 집합 + 블록 root + 날짜로 해시 → 팀 전원이 동일 키를 산출(팀 공유
    잠금). 솔로면 자기 미션 단위. 키를 만들 수 없으면 None(→ 잠금 미적용, 안전 통과).
    """
    if not manage:
        return None
    comp_raw = _safe_str(manage.get('companion_id')).strip()
    if comp_raw:
        self_bot = _safe_str(manage.get('bot_id')).strip()
        block_root = (_safe_str(manage.get('parent_area_id')).strip()
                      or _safe_str(manage.get('area_id')).strip())
        bots = sorted({b.strip() for b in (comp_raw.split(',') + [self_bot]) if b.strip()})
        basis = f"{block_root}|{datetime.now():%Y-%m-%d}|{','.join(bots)}"
        return 'T:' + hashlib.md5(basis.encode('utf-8')).hexdigest()
    mid = manage.get('mission_id')
    return f'M:{mid}' if mid is not None else None


def _get_committed_branch(cursor, run_key, branch_group):
    """run_key 회차에서 branch_group 갈림길에 이미 확정된 노드 area_id. 없으면 None."""
    if not run_key or not branch_group:
        return None
    try:
        cursor.execute(
            "select chosen_area_id from bot_mission_branch "
            "where run_key = %s and branch_group = %s limit 1",
            [run_key, branch_group])
        row = cursor.fetchone()
    except Exception as e:
        logging.warning(f'분기 선택 조회 실패(무시): {e}')
        return None
    return row.get('chosen_area_id') if row else None


def _commit_branch(cursor, run_key, branch_group, chosen_area_id):
    """branch_group 갈림길의 최초 선택을 기록(멱등). 이미 있으면 최초 선택을 보존한다."""
    if not run_key or not branch_group or not chosen_area_id:
        return
    try:
        cursor.execute(
            "INSERT IGNORE INTO bot_mission_branch (run_key, branch_group, chosen_area_id) "
            "VALUES (%s, %s, %s)",
            [run_key, branch_group, chosen_area_id])
    except Exception as e:
        logging.warning(f'분기 선택 기록 실패(무시): {e}')


def _branch_locked_msg(area_name):
    """다른 갈래를 이미 선택해 진입이 막혔을 때의 안내."""
    try:
        post = Josa.get_full_string(area_name, "을")
    except Exception:
        post = f'{area_name}을(를)'
    return (f'이미 다른 갈래로 들어선 뒤다……. 되돌아가 {post} 향할 수는 없을 것 같다. '
            f'가던 길을 계속 가 보자.')


# ==========================================
# 진행 중 임무 / 신규 임무 분기
# ==========================================
def _handle_ongoing_mission(cursor, char, manage, normalized_area, area_name, area_action, potion, user_id):
    """진행 중 임무에서 다음 지역으로 이동."""
    area = _load_sub_area(cursor, normalized_area, manage.get('parent_area_id'), manage.get('up_area_id'))
    if not area:
        return _area_not_found_msg(area_name)

    # 0) 배타적 갈림길 잠금 — 부작용(키 소모/힐링/위치이동) 전에 먼저 거부한다.
    #    이 회차에 같은 갈림길 그룹의 '다른' 노드를 이미 선택했다면 진입 불가.
    run_key = _branch_run_key(manage)
    branch_group = _safe_str(area.get('branch_group')).strip()
    if branch_group and run_key:
        chosen = _get_committed_branch(cursor, run_key, branch_group)
        if chosen and chosen != area.get('area_id'):
            return _branch_locked_msg(area_name)

    # 1) 조건 검사
    suc, msg = consume_key_items(cursor, char['ch_id'], area)
    if not suc:
        return msg
    suc, msg = check_time_limit(area)
    if not suc:
        return msg

    # 2) 힐링 지역
    healing_hp = _safe_int(area.get('healing_hp'), 0)
    if healing_hp > 0:
        ch_hp = _safe_int(char.get('hp'), 0)
        cursor.execute(
            "update avo_status_character set sc_value = %s where ch_id = %s and st_id = 4",
            [max(0, ch_hp - healing_hp), char['ch_id']])

    # 2.5) 갈림길 선택 확정 — 모든 게이트를 통과해 진입이 확정된 시점에 최초 1회 기록.
    if branch_group and run_key:
        _commit_branch(cursor, run_key, branch_group, area.get('area_id'))

    # 3) bot_mission_manage 위치 업데이트
    cursor.execute(
        "update bot_mission_manage set up_area_id = %s, parent_area_id = %s, area_id = %s, last_dt = now() "
        "where mission_id = %s",
        [manage.get('up_area_id'), manage.get('parent_area_id'), area['area_id'], manage['mission_id']])

    # 인카운터 확률 상승
    try:
        enemy_encounter()
    except Exception as e:
        logging.warning(f'enemy_encounter 호출 실패(진행 계속): {e}')

    inc_cd = _safe_str(area.get('incounter_cd'))

    # 4) 인카운터 라우팅 — 각 핸들러의 결과에 area-기반 이미지를 첨부할 수 있도록 wrap
    if inc_cd in INCOUNTER_PASS_THROUGH:
        return _maybe_attach_area_image(_handle_passthrough(cursor, char, area, manage), area)
    if INCOUNTER_TRADE_ITEM_GOLD in inc_cd:
        return _maybe_attach_area_image(_handle_trade_item_to_gold(cursor, char, area), area)
    if INCOUNTER_TRADE_ITEM_ITEM in inc_cd:
        return _maybe_attach_area_image(_handle_trade_item_to_item(cursor, char, area), area)
    if INCOUNTER_TRADE_GOLD_ITEM in inc_cd:
        return _maybe_attach_area_image(_handle_trade_gold_to_item(cursor, char, area), area)
    if INCOUNTER_SKILL_CHECK in inc_cd:
        return _maybe_attach_area_image(
            _handle_skill_check(cursor, char, area, area_action, potion, user_id, area_name, manage),
            area)
    if inc_cd == INCOUNTER_COMPLETE:
        return _maybe_attach_area_image(_handle_completion(cursor, char, area, manage), area)

    # 미지정/알 수 없는 인카운터 — 안전하게 텍스트만 반환
    logging.warning(f'알 수 없는 incounter_cd={inc_cd!r} (area_id={area.get("area_id")})')
    return _maybe_attach_area_image(extract_cn(cursor, char, area, '', manage=manage), area)


def _start_new_mission(cursor, char, normalized_area, area_name, user_id):
    """신규 임무 시작 (솔로)."""
    ch_id = char['ch_id']

    # 오늘 실패 이력이 있으면 진행 불가
    cursor.execute(
        "select 1 from bot_area_mission where ch_id = %s and date(start_dt) = curdate() "
        "and mission_result = 'FAIL' limit 1",
        [ch_id])
    if cursor.fetchone():
        return ('이전 지역 임무에서 실패하여, 다른 지역으로 갈 수는 없을 것 같다……. '
                '[재도전]을 할 수 없다면, 교단으로 복귀하여 쉬는 것이 좋겠다.\n\n▶[지역/포기]')

    # 진입 차단 지역 — 안내 문구만 출력하고 임무 시작을 막는다.
    blocked_msg = _blocked_area_msg(normalized_area)
    if blocked_msg:
        return blocked_msg

    area = _load_area_by_name(cursor, normalized_area)
    if not area:
        return _area_not_found_msg(area_name)

    # 미개방 지역 진입 차단 (open_yn = 'N')
    if area.get('open_yn') == 'N':
        try:
            post = Josa.get_full_string(area_name, "은")
        except Exception:
            post = f'{area_name}은(는)'
        return f'{post} 아직 들어갈 수 없는 지역인 것 같다……. 다른 곳을 먼저 개방해 보자.'

    # 선행 완료 게이트 — 지정된 선행 지역을 (전 유저 통틀어 누군가) 클리어해야 진입 가능
    #   (리세움 안뜰 클리어 → 경당, 경당 클리어 → 계시 성소)
    gate_msg = _check_area_prerequisite(cursor, normalized_area, area_name)
    if gate_msg:
        return gate_msg

    # 솔로 블록 한도 — '기회 소모 안 함'(no_consume_yn='Y') 또는 VATICAN 은 면제.
    # INCUNTR_99 로 직전 블록을 마쳤어도 이미 SOLO_MAX_BLOCKS(=1) 만큼 시작했다면 추가 진입 불가.
    a_id = area.get('area_id')
    p_a_id = area.get('parent_area_id') or a_id
    no_consume = _area_no_consume(area)
    if not no_consume:
        cur_cnt = _get_area_mission_cnt(cursor, ch_id)
        if cur_cnt >= SOLO_MAX_BLOCKS:
            return ('오늘은 더 이상 혼자 탐사할 수 없을 것 같다……. '
                    '다음에 다시 도전하거나, 동료와 [동행]해 보자.')

    open_roll = _safe_int(area.get('open_roll'), 0)
    open_roll_cnt = _safe_int(area.get('open_roll_cnt'), 0)
    if open_roll != 0 and open_roll_cnt < open_roll:
        try:
            post = Josa.get_full_string(area_name, "을")
        except Exception:
            post = f'{area_name}을(를)'
        return f'{post} 지나가기엔 힘이 부족하다……. 다른 교단원에게 지원을 요청해 보자.'

    suc, msg = consume_key_items(cursor, ch_id, area)
    if not suc:
        return msg
    suc, msg = check_time_limit(area)
    if not suc:
        return msg

    keyword_row = extract_cn(cursor, char, area, '')
    try:
        enemy_encounter()
    except Exception as e:
        logging.warning(f'enemy_encounter 호출 실패(진행 계속): {e}')

    parent_id = area.get('parent_area_id') or area['area_id']
    cursor.execute(
        "insert into bot_mission_manage (ch_id, bot_id, up_area_id, parent_area_id, area_id, start_dt, mission_result) "
        "values (%s, %s, %s, %s, %s, now(), 'ING')",
        [ch_id, user_id, area.get('up_area_id'), parent_id, area['area_id']])

    cursor.execute(
        "select mission_id from bot_area_mission where ch_id = %s and date(start_dt) = curdate() "
        "and mission_result = 'ING' order by mission_id desc limit 1",
        [ch_id])
    new_mission = cursor.fetchone()
    new_mission_id = new_mission and new_mission.get('mission_id')
    if new_mission_id is not None:
        prev_cnt = _get_area_mission_cnt(cursor, ch_id)
        # 기회 소모 안 함(no_consume: no_consume_yn='Y' 또는 VATICAN) 이면
        # 카운트 증가 없이 mission_id 만 갱신
        next_cnt = prev_cnt if no_consume else prev_cnt + 1
        cursor.execute(
            "update bot_count set area_mission_cnt = %s, area_mission_id = %s where ch_id = %s",
            [next_cnt, new_mission_id, ch_id])

    # 시작 지역 visit 기록 — 동행/첫 탐사 게이트의 일관된 평가 근거.
    _record_area_visit(cursor, ch_id, a_id, new_mission_id)

    return _maybe_attach_area_image(keyword_row, area)


# ==========================================
# 메인 진입점
# ==========================================
def area_mission(user_id, area_name, area_action, potion):
    """[지역/area_name/area_action/potion] 진입점."""
    if area_name is None:
        area_name = ''
    normalized_area = area_name.replace(" ", "")
    ctx_label = f'지역/{area_name}'

    # 시즌/휴무 게이트 — 지역임무 기간(시즌) 밖이거나, 기간 내라도 금요일 휴무면 도전 불가.
    # (개막일 예외 포함. DB 접근 전에 먼저 차단하여 불필요한 커넥션도 아낀다.)
    season_block = _area_season_block_msg()
    if season_block:
        return season_block

    try:
        with get_db_cursor() as cursor:
            char = _load_character(cursor, user_id)
            if not char:
                return '캐릭터 정보를 찾을 수 없습니다. 운영 계정에 DM을 부탁드립니다.'

            ch_id = char['ch_id']
            hp_left = _safe_int(char.get('max_hp'), 0) - _safe_int(char.get('hp'), 0)

            # 오늘 진행 중/실패 임무 조회
            cursor.execute(
                "select * from bot_area_mission where ch_id = %s "
                "and date(start_dt) = curdate() and mission_result != 'SUCC'",
                [ch_id])
            manage = cursor.fetchone()

            # --- [포기] ---
            if normalized_area == '포기':
                if not manage:
                    return '아직 지역 임무에 도전하지 않았던 것 같다. 임무를 수행하러 가볼까?'
                return _handle_giveup(cursor, char, manage)

            # 진입 차단 지역 — 신규/진행중 경로로 갈리기 전에 먼저 막는다.
            # (진행 중 임무 이동 경로 _handle_ongoing_mission 은 자체 차단 검사가
            #  없으므로, 여기서 막지 않으면 차단 지역이 통째로 빠져나간다.)
            blocked_msg = _blocked_area_msg(normalized_area)
            if blocked_msg:
                return blocked_msg

            if hp_left < 1:
                return HP_TOO_LOW_MSG

            # --- 진행 중 ---
            if manage and manage.get('mission_result') == 'ING':
                return _handle_ongoing_mission(
                    cursor, char, manage, normalized_area, area_name, area_action, potion, user_id)

            # --- 신규 시작 ---
            return _start_new_mission(cursor, char, normalized_area, area_name, user_id)

    except Exception as e:
        logging.error(f'지역 탐사 오류: {e}\n{traceback.format_exc()}\n입력=[{ctx_label}]')
        return _system_error(ctx_label)


# ==========================================
# 지역 스크립트 추출
# ==========================================
def _parse_tag(keyword_row):
    """
    keyword_row 에서 첫 {...} 태그를 파싱하여 (full_tag, tag_content_upper, dice_result) 반환.
    태그가 없으면 (None, '', 0).
    """
    if not keyword_row:
        return None, '', 0
    if '{' not in keyword_row or '}' not in keyword_row:
        return None, '', 0
    start = keyword_row.find('{')
    end = keyword_row.find('}')
    if start >= end:
        return None, '', 0
    full_tag = keyword_row[start:end + 1]
    content = full_tag[1:-1].upper()
    return full_tag, content, 0


def _resolve_tag(full_tag, content):
    """태그를 치환할 문자열 + (dice 사용 시) 굴린 값 반환."""
    if content == '' or content is None:
        return full_tag, 0
    if 'NAME' in content:
        return full_tag, 0  # STEP 4에서 일괄 처리
    if 'D' in content and '/' not in content:
        parts = content.split('D')
        if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
            try:
                rolled = random_dice(parts[0], parts[1])
                return str(rolled), rolled
            except Exception:
                return full_tag, 0
        return full_tag, 0
    if '/' in content:
        choices = [c for c in content.split('/') if c]
        if choices:
            return random.choice(choices), 0
    return full_tag, 0


def _calc_drop_count(item_drop_val, tag_content, dice_result):
    """아이템 드랍 개수 계산. 잘못된 포맷은 1."""
    if item_drop_val is None or item_drop_val == '':
        return 1
    s = str(item_drop_val).upper().strip()
    # 텍스트 태그가 dice 였고 그 dice 식이 item_drop과 일치하면, 텍스트 굴림 결과를 그대로 사용
    if dice_result > 0 and s == tag_content:
        return dice_result
    if s.isdigit():
        return _safe_int(s, 1)
    if 'D' in s:
        return _roll_dice_expr(s, default=1)
    return 1


def _award_area_items(cursor, area, ch_id, ch_name, tag_content='', dice_result=0,
                      mark_granted=False):
    """area.item_id 를 ch_id 에게 지급한다.

    드랍 개수(_calc_drop_count)는 호출할 때마다 굴리므로, 멤버별로 따로 호출하면
    자연히 '멤버별 개별 굴림'이 된다. SINGLE_INSTANCE 아이템은 미보유 시에만 1개 지급.
    mark_granted=True(첫 탐사 1회성 지역)이고 실제 지급되면 drop_granted_yn='Y' 마킹.

    반환: 실제로 한 개라도 지급되었는지(bool).
    """
    if area.get('item_id') is None:
        return False
    item_ids = _parse_id_list(area.get('item_id'))
    drop_count = _calc_drop_count(area.get('item_drop'), tag_content, dice_result)
    granted_any = False
    for item_id in item_ids:
        it_name = _lookup_item_name(cursor, item_id)
        if not it_name:
            continue
        if item_id in SINGLE_INSTANCE_ITEM_IDS:
            cursor.execute(
                "select in_id from avo_inventory where it_id = %s and ch_id = %s limit 1",
                [item_id, ch_id])
            if not cursor.fetchone():
                _award_item(cursor, item_id, it_name, ch_id, ch_name, 1)
                granted_any = True
        else:
            _award_item(cursor, item_id, it_name, ch_id, ch_name, drop_count)
            granted_any = True
    if mark_granted and granted_any:
        _mark_drop_granted(cursor, ch_id, area.get('area_id'))
    return granted_any


def extract_cn(cursor, character, area, cn_type, manage=None):
    """지역 스크립트 추출 및 아이템 지급 처리.

    주의: 자체 DB 커넥션을 더 이상 열지 않는다. 호출자가 가지고 있는 cursor 를 그대로 사용하여
    동일 트랜잭션 안에서 아이템 지급 및 inventory 조회를 수행한다 (중첩 트랜잭션/커넥션 풀
    고갈 방지).

    하위 호환을 위한 모듈 레벨 헬퍼 `extract_cn_with_own_conn` 는 별도로 제공하지 않는다.
    외부 모듈에서 cursor 없이 호출하던 시그니처가 있다면 cursor 인자를 추가해야 한다.
    """
    if not character or not area:
        return ''
    try:
        ch_id = _safe_int(character.get('ch_id'), 0)
        ch_name = _safe_str(character.get('ch_name'))
        ch_class = _safe_int(character.get('ch_class'), 0)

        f_drop = area.get('first_drop_yn')
        f_check = area.get('first_check_yn')

        keyword_row = ''
        is_item_event = False
        mark_granted = False  # 첫 탐사 1회성 지역에서 실제 지급 시 멱등 마킹할지

        # STEP 1: 기본 텍스트 선정
        if cn_type == 'fail':
            keyword_row = _safe_str(area.get('fail_cn'))
        elif cn_type == 'succ':
            keyword_row = _safe_str(area.get('succ_cn'))
            is_item_event = True
        else:
            keyword_row = _safe_str(area.get('area_cn'))
            # 첫 탐사 자격 — clear_yn 이 아니라 '첫 팀 멤버 & 개인 미수령' 으로 판정.
            #   동행 멤버가 서로 다른 시점에 도착해도 각자 첫 도착 시 1회 지급된다.
            personal_first = _is_first_explore_recipient(cursor, area, ch_id, character, manage)
            if f_check == 'Y' and not personal_first:
                # 첫 탐사 스크립트 게이트 지역 — 자격 없는 방문자는 '이미 탐사' 스크립트
                keyword_row = _safe_str(area.get('check_fail_cn'))
            else:
                open_race = area.get('open_race')
                race_ok = True
                if open_race:
                    race_key = str(open_race)
                    if race_key == 'H_ALL':
                        race_ok = ch_class in HALF_HUMAN_CLASSES
                    else:
                        race_ok = (ch_class == RACE_TO_CH_CLASS.get(race_key))
                if not race_ok:
                    keyword_row = _safe_str(area.get('race_fail_cn'))
                elif f_drop == 'N':
                    is_item_event = True            # 반복 지역: 누구나 매번 지급
                elif f_drop == 'Y':
                    if personal_first:
                        is_item_event = True        # 첫 팀 멤버 1회 지급
                        mark_granted = True
                    else:
                        # 1회성 지역인데 비자격/이미 수령 → 안내문(있으면)만, 아이템 없음
                        drop_fail = area.get('drop_fail_cn')
                        if drop_fail:
                            keyword_row = _safe_str(drop_fail)
                # 그 외(first_drop_yn 미설정) → 아이템 지급 없음 (구 동작 유지)

        # STEP 2: 태그 치환
        full_tag, tag_content, _ = _parse_tag(keyword_row)
        dice_result = 0
        if full_tag is not None:
            replacement, dice_result = _resolve_tag(full_tag, tag_content)
            keyword_row = keyword_row.replace(full_tag, replacement, 1)

        # STEP 3: 아이템 지급 (호출당 1회 굴림 = 멤버별 개별 굴림)
        if is_item_event and area.get('item_id') is not None:
            _award_area_items(cursor, area, ch_id, ch_name,
                              tag_content, dice_result, mark_granted)

        # STEP 4: 이름 치환 후 반환
        return keyword_row.replace('{name}', ch_name).replace('{NAME}', ch_name)

    except Exception as e:
        logging.error(f'지역 스크립트 추출 오류: {e}\n{traceback.format_exc()}')
        return _system_error('지역 스크립트 추출 시스템')


# ==========================================
# 동행 탐사 시스템
# ==========================================
def _validate_companion(cursor, comp_name, my_ch_name, skip_block_limit=False):
    """동행 1명에 대해 검증. (ok, error_msg, comp_row).

    skip_block_limit=True 면 동행원의 블록 한도 검사를 생략한다
    (기회 소모 안 함 지역: no_consume_yn='Y' 또는 VATICAN — 어차피 소모하지 않으므로
     한도가 찬 동행원도 함께 갈 수 있다).
    """
    if comp_name == my_ch_name:
        return False, "※ 동행 시, 동행인 명단을 적을 때는 자신의 이름을 제외해야 합니다. 다시 시도해 주세요.", None

    comp = _load_character_by_name(cursor, comp_name)
    if not comp:
        try:
            post = Josa.get_full_string(comp_name, "는")
        except Exception:
            post = f'{comp_name}은(는)'
        return False, f'{post} 존재하지 않는 교단원 같다……. 상대의 이름을 다시 떠올려 보자.', None

    if _safe_int(comp.get('max_hp'), 0) - _safe_int(comp.get('hp'), 0) < 1:
        try:
            sub = Josa.get_full_string(comp_name, "가")
        except Exception:
            sub = f'{comp_name}이(가)'
        return False, (
            f'{sub} 지금 몸 상태로 임무에 나가면 위험할 것 같다……. '
            f'우선 {comp_name}의 체력부터 회복하고 보자.'), None

    if not skip_block_limit and _get_area_mission_cnt(cursor, comp['ch_id']) >= COMPANION_MAX_BLOCKS:
        try:
            post = Josa.get_full_string(comp_name, "는")
        except Exception:
            post = f'{comp_name}은(는)'
        return False, f'{post} 더 이상 지역 임무를 나갈 수 없을 것 같다……. 다음에 [동행]하자.', None

    return True, '', comp


def _register_mission_for(cursor, ch_id, bot_id, other_bots, u_a_id, p_a_id, a_id):
    """동행 멤버 1명의 mission_manage row 등록 + 카운트 갱신. mission_id 반환."""
    cursor.execute(
        "insert into bot_mission_manage (ch_id, bot_id, companion_id, up_area_id, parent_area_id, area_id, start_dt, mission_result) "
        "values (%s, %s, %s, %s, %s, %s, now(), 'ING')",
        [ch_id, bot_id, other_bots, u_a_id, p_a_id, a_id])
    cursor.execute(
        "select mission_id from bot_area_mission where ch_id = %s and date(start_dt) = curdate() "
        "and mission_result = 'ING' order by mission_id desc limit 1",
        [ch_id])
    row = cursor.fetchone()
    return row.get('mission_id') if row else None


def with_companion(user_id, area_name, companion_name):
    """[동행/area_name/comp1,comp2,...] 진입점."""
    if area_name is None:
        area_name = ''
    if companion_name is None:
        companion_name = ''
    normalized_area = area_name.replace(" ", "")
    ctx_label = f'동행/{area_name}/{companion_name}'

    # 시즌/휴무 게이트 — 솔로 [지역]과 동일 규칙(시즌 밖/금요일 휴무는 도전 불가, 개막일 예외).
    season_block = _area_season_block_msg()
    if season_block:
        return season_block

    try:
        with get_db_cursor() as cursor:
            char = _load_character(cursor, user_id)
            if not char:
                return '캐릭터 정보를 찾을 수 없습니다. 운영 계정에 DM을 부탁드립니다.'

            ch_id = char['ch_id']
            ch_name = char['ch_name']

            # 진입 차단 지역 — 안내 문구만 출력하고 임무 시작을 막는다.
            blocked_msg = _blocked_area_msg(normalized_area)
            if blocked_msg:
                return blocked_msg

            # 지역 조회 - null 체크 먼저 (★ 기존 버그 수정: consume_key_items 이전에 null 체크)
            area = _load_area_by_name(cursor, normalized_area)
            if not area or area.get('open_yn') == 'N':
                return _area_not_found_msg(area_name)

            # 키 아이템 처리는 파티(동행원)까지 확정된 뒤에 수행한다.
            # (key_all_yn='Y' 이면 파티 전원의 키를 검사/소모해야 하므로 동행 목록이 먼저 필요.
            #  또한 다른 검증(HP/한도/동행/선행)을 통과한 '진입 확정' 시점에 소모하여
            #  거절 시 키가 낭비되지 않게 한다.)

            if _safe_int(char.get('max_hp'), 0) - _safe_int(char.get('hp'), 0) < 1:
                return HP_TOO_LOW_MSG

            # 지역임무 기회(블록 한도) 소모 안 함 — no_consume_yn='Y' 또는 VATICAN 면제.
            no_consume = _area_no_consume(area)

            my_cnt = _get_area_mission_cnt(cursor, ch_id)
            if not no_consume and my_cnt >= COMPANION_MAX_BLOCKS:
                return '오늘은 더 이상 지역 임무를 나갈 수 없을 것 같다……. 다음에 [동행]하자.'

            # 동행 검증 (기회 소모 안 함 지역이면 동행원 블록 한도 검사도 생략)
            companions = [c.strip() for c in companion_name.split(',') if c.strip()]
            if not companions:
                return '이런, 동행인을 놓쳤다! 다시 출발하자.\n\n▶[동행/지역명/동료 캐릭터명]'

            comp_data = []   # list[(ch_id, bot_id)]
            comp_chars = []  # list[dict] — 동행원 캐릭터 (입장 지역 아이템 지급용)
            for comp_name in companions:
                ok, err, comp = _validate_companion(
                    cursor, comp_name, ch_name, skip_block_limit=no_consume)
                if not ok:
                    return err
                comp_data.append((comp['ch_id'], comp['bot']))
                comp_chars.append(comp)

            # 선행 완료 게이트 — 전 유저 공유. 선행 지역을 누군가 클리어했으면 진입 가능.
            #   (리세움 안뜰 클리어 → 경당, 경당 클리어 → 계시 성소)
            gate_msg = _check_area_prerequisite(cursor, normalized_area, area_name)
            if gate_msg:
                return gate_msg

            # 키 아이템 처리 — 파티 전원 소모 여부(key_all_yn, 기본 Y) 에 따라 분기.
            #   Y(기본): 파티 전원(대표+동행원) 보유 검사 + 전원 소모.
            #           한 명이라도 없으면 아무도 소모하지 않고 차단.
            #   N     : 대표(호출자) 한 명만 검사/소모(기존 동작).
            party_ch_ids = [c_id for c_id, _ in comp_data] + [ch_id]
            suc, msg = _consume_party_key_items(cursor, party_ch_ids, area, ch_id)
            if not suc:
                return msg

            u_a_id = area.get('up_area_id')
            p_a_id = area.get('parent_area_id') or area['area_id']
            a_id = area['area_id']

            all_bots = [b for _, b in comp_data] + [user_id]

            # 각 동행에 대해 mission 등록 + count 증가
            for c_id, c_bot in comp_data:
                other_bots = ','.join([b for b in all_bots if b != c_bot])
                m_id = _register_mission_for(cursor, c_id, c_bot, other_bots, u_a_id, p_a_id, a_id)
                if m_id is None:
                    logging.warning(f'동행 mission_id 조회 실패: ch_id={c_id}')
                    continue
                if no_consume:
                    # 기회 소모 안 함 — 카운트 증가 없이 mission_id 만 갱신
                    cursor.execute(
                        "update bot_count set area_mission_id = %s where ch_id = %s",
                        [m_id, c_id])
                else:
                    cursor.execute(
                        "update bot_count set area_mission_cnt = area_mission_cnt + 1, area_mission_id = %s "
                        "where ch_id = %s",
                        [m_id, c_id])

            # 본인 등록
            other_bots = ','.join([b for b in all_bots if b != user_id])
            my_m_id = _register_mission_for(cursor, ch_id, user_id, other_bots, u_a_id, p_a_id, a_id)
            if my_m_id is None:
                logging.error(f'본인 mission_id 조회 실패: ch_id={ch_id}')
                return _system_error(ctx_label)

            # 기회 소모 안 함(no_consume) 이면 본인 카운트도 증가시키지 않는다.
            if not no_consume:
                my_cnt += 1
            cursor.execute(
                "update bot_count set area_mission_cnt = %s, area_mission_id = %s where ch_id = %s",
                [my_cnt, my_m_id, ch_id])

            # ★ 동행 시작 시점에 팀 전원의 visit 을 일괄 기록.
            #   - 첫 탐사 팀 게이트가 출발 즉시 평가 가능 (전원 visit → clear_yn='Y' 플립)
            #   - 동행자가 개별 [지역] 명령을 미처 안 쳐도 visit 이력 일관성 보장
            #   - 보상/감사 헬퍼(verify_team_visited_area) 가 정확히 동작
            for c_id, _ in comp_data:
                _record_area_visit(cursor, c_id, a_id, None)
            _record_area_visit(cursor, ch_id, a_id, my_m_id)

            # 본인 기준으로 첫 탐사 팀 게이트 평가 (전원 visit 완료 시 즉시 플립)
            # 본인의 manage 객체를 가짜로 만들어 _maybe_flip_area_cleared 호출.
            faux_manage = {
                'mission_id': my_m_id,
                'companion_id': ','.join(b for b in all_bots if b != user_id),
            }
            _maybe_flip_area_cleared(cursor, char, faux_manage, area)

            result = _maybe_attach_area_image(
                extract_cn(cursor, char, area, '', manage=faux_manage), area)

            # 입장 지역은 동행원이 직접 extract_cn 을 거치지 않으므로(미션만 등록됨),
            # 여기서 동행원 전원에게도 동일 게이트(첫 팀 멤버 & 미수령)로 첫 탐사 아이템을
            # 지급한다. 멤버별로 extract_cn 을 호출하므로 드랍 개수도 멤버별 개별 굴림이 된다.
            # (깊은 지역은 각 동행원이 [지역] 으로 이동할 때 extract_cn 에서 개별 처리된다.)
            for comp_char in comp_chars:
                comp_faux_manage = {
                    'mission_id': faux_manage['mission_id'],
                    'companion_id': ','.join(
                        b for b in all_bots if b != comp_char.get('bot')),
                }
                extract_cn(cursor, comp_char, area, '', manage=comp_faux_manage)

            return result

    except Exception as e:
        logging.error(f'동행 오류: {e}\n{traceback.format_exc()}\n입력=[{ctx_label}]')
        return _system_error(ctx_label)
