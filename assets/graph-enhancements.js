<script>
/* enhancements: graph lock, neighbor highlight, orphan fix, project name sync
   File: assets/graph-enhancements.js (inlined here for commit into index.html)
   This script assumes DATA, PROJECTS, PROJECT_ID, rowById, C, nameToIdByRegion, parseChoices, render, rebuildProjectView exist.
*/
(function(){
  'use strict';
  // Prevent double-install
  if(window.__graphEnhancementsInstalled) return; window.__graphEnhancementsInstalled = true;

  var graphLocked = false;
  var highlightedNodeId = null;

  function showToast(msg, ms){
    try{
      var t = document.getElementById('toast'); if(!t) return; t.textContent = msg; t.classList.add('show'); setTimeout(function(){ t.classList.remove('show'); }, ms||1500);
    }catch(e){console.warn(e);}  
  }

  function ensureGraphLockButton(){
    try{
      var toolbar = document.querySelector('.canvasToolbar');
      if(!toolbar){ setTimeout(ensureGraphLockButton, 600); return; }
      if(document.getElementById('btnGraphLock')) return;
      var btn = document.createElement('button'); btn.id='btnGraphLock'; btn.className='ghost'; btn.title='잠금 시 노드 상호작용을 막습니다'; btn.textContent='그래프 잠금 ▸';
      btn.addEventListener('click', function(){ graphLocked = !graphLocked; btn.textContent = graphLocked ? '그래프 잠금 ✓' : '그래프 잠금 ▸'; btn.classList.toggle('primary', graphLocked); showToast(graphLocked? '그래프 잠금: 활성화' : '그래프 잠금: 해제', 1200); });
      toolbar.appendChild(btn);
    }catch(e){ console.error('ensureGraphLockButton',e); }
  }

  function clearAllHighlights(){
    document.querySelectorAll('.canvasNode').forEach(function(el){ el.classList.remove('neighbor-prev','neighbor-next','neighbor-selected','dimmed'); el.style.opacity=''; el.style.boxShadow=''; el.style.zIndex=''; });
    document.querySelectorAll('#clusterCanvasSvg .canvasEdge').forEach(function(e){ e.classList.remove('edge-highlight','edge-dim'); e.style.strokeWidth='1.5'; e.style.opacity=''; e.style.stroke=''; });
  }
  function applyHighlight(selectedId, prevIds, nextIds){
    clearAllHighlights(); highlightedNodeId = selectedId;
    document.querySelectorAll('.canvasNode').forEach(function(el){
      var nid = el.getAttribute('data-nodeid') || el.getAttribute('data-rowid') || el.getAttribute('data-regionid') || el.id;
      if(!nid) return;
      if(nid == selectedId){ el.classList.add('neighbor-selected'); el.style.boxShadow='0 6px 22px rgba(52,87,213,.35)'; el.style.zIndex=100; }
      else if(prevIds.indexOf(nid)!==-1){ el.classList.add('neighbor-prev'); el.style.borderColor='#1a8a4a'; el.style.boxShadow='0 4px 14px rgba(26,138,74,.18)'; }
      else if(nextIds.indexOf(nid)!==-1){ el.classList.add('neighbor-next'); el.style.borderColor='#3457d5'; el.style.boxShadow='0 4px 14px rgba(52,87,213,.18)'; }
      else { el.classList.add('dimmed'); el.style.opacity=0.35; }
    });
    document.querySelectorAll('#clusterCanvasSvg .canvasEdge').forEach(function(e){
      var f = e.getAttribute('data-from'), t = e.getAttribute('data-to');
      if(!f||!t){ e.classList.add('edge-dim'); e.style.opacity=0.12; return; }
      if((f==selectedId && nextIds.indexOf(t)!==-1) || (t==selectedId && prevIds.indexOf(f)!==-1)){
        e.classList.add('edge-highlight'); e.style.strokeWidth='3'; e.style.opacity=1; e.style.stroke=getComputedStyle(document.documentElement).getPropertyValue('--accent')||'#3457d5';
      } else { e.classList.add('edge-dim'); e.style.opacity=0.12; }
    });
  }

  function getLinkedNodeIdsByRow(rowIndex){
    var res = { prev:[], next:[] };
    try{
      var rows = DATA.sheet1.rows; if(!rows[rowIndex]) return res;
      var scriptIdx = C['스크립트(내용)'], succIdx = C['성공 스크립트'], failIdx = C['실패 스크립트'];
      var idIdx = C['지역ID'], nameIdx = C['지역명'];
      var parse = window.parseChoices || function(s){ if(!s) return []; return s.split(/[\r\n,]+/).map(function(x){ return x.trim(); }).filter(Boolean); };
      var nextNames = [].concat(parse(rows[rowIndex][scriptIdx]||''), parse(rows[rowIndex][succIdx]||''), parse(rows[rowIndex][failIdx]||''));
      nextNames = nextNames.filter(function(n){ return n && n!=='이동한다'; });
      var top = rows[rowIndex][ C['상위지역ID(부모ID)'] ] || rows[rowIndex][ idIdx ];
      nextNames.forEach(function(n){ var candidateId = (nameToIdByRegion[top] && nameToIdByRegion[top][n]) || null; if(candidateId) res.next.push(candidateId); });
      var name = rows[rowIndex][nameIdx]; var topKey = top;
      rows.forEach(function(rr,ri){ if(ri===rowIndex) return; var rtop = rr[ C['상위지역ID(부모ID)'] ] || rr[ idIdx ]; if(rtop!==topKey) return; var choices = [].concat(parse(rr[scriptIdx]||''), parse(rr[succIdx]||''), parse(rr[failIdx]||'')).filter(function(x){ return x && x!=='이동한다'; }); choices.forEach(function(ch){ if(ch===name) res.prev.push(rr[ idIdx ]); else if(nameToIdByRegion[topKey] && nameToIdByRegion[topKey][ch] && nameToIdByRegion[topKey][ch]===rows[rowIndex][idIdx]) res.prev.push(rr[ idIdx ]); }); });
    }catch(e){ console.error('getLinkedNodeIdsByRow',e); }
    return res;
  }

  function attachCanvasNodeClickHandlers(){
    try{
      var inner = document.getElementById('clusterCanvasInner') || document.querySelector('#clusterCanvasInner');
      if(!inner){ setTimeout(attachCanvasNodeClickHandlers,600); return; }
      inner.addEventListener('click', function(ev){
        var el = ev.target; while(el && !el.classList.contains('canvasNode')) el = el.parentElement; if(!el) return;
        if(graphLocked){ showToast('그래프가 잠겨 있어 상호작용을 할 수 없습니다',1000); return; }
        var rowId = el.getAttribute('data-rowid') || el.getAttribute('data-nodeid') || el.getAttribute('data-regionid') || el.id; if(!rowId) return;
        var rowIndex = -1; if(rowById && rowById[rowId] != null) rowIndex = rowById[rowId]; else { var n=parseInt(rowId,10); if(!isNaN(n)) rowIndex=n; }
        if(rowIndex===-1){ for(var i=0;i<DATA.sheet1.rows.length;i++){ if(DATA.sheet1.rows[i][C['지역ID']]==rowId){ rowIndex=i; break; } } }
        if(rowIndex===-1) return;
        var linked = getLinkedNodeIdsByRow(rowIndex);
        applyHighlight(DATA.sheet1.rows[rowIndex][ C['지역ID'] ], linked.prev, linked.next);
        if(ev.ctrlKey || ev.metaKey){ try{ renderNodePanel( DATA.sheet1.rows[rowIndex][ C['상위지역ID(부모ID)'] ] || DATA.sheet1.rows[rowIndex][ C['지역ID'] ], DATA.sheet1.rows[rowIndex][ C['지역ID'] ] ); }catch(e){} }
      }, true);
    }catch(e){ console.error('attachCanvasNodeClickHandlers', e); }
  }

  function isActuallyOrphan(regionId){
    try{
      if(!regionId) return true; var ridx = rowById && rowById[regionId]!=null ? rowById[regionId] : -1; if(ridx===-1) return true;
      var rows = DATA.sheet1.rows; var r = rows[ridx]; var parse = window.parseChoices || function(s){ if(!s) return []; return s.split(/[\r\n,]+/).map(function(x){ return x.trim(); }).filter(Boolean); };
      var scriptIdx = C['스크립트(내용)'], succIdx = C['성공 스크립트'], failIdx = C['실패 스크립트'];
      var outNames = [].concat(parse(r[scriptIdx]||''), parse(r[succIdx]||''), parse(r[failIdx]||'')).filter(function(x){ return x && x!=='이동한다'; });
      if(outNames.length){ var top = r[C['상위지역ID(부모ID)']] || r[C['지역ID']]; for(var i=0;i<outNames.length;i++){ var nm=outNames[i]; if(nameToIdByRegion[top] && nameToIdByRegion[top][nm]) return false; } }
      var name = r[C['지역명']]; var topKey = r[ C['상위지역ID(부모ID)'] ] || r[ C['지역ID'] ]; for(var j=0;j<rows.length;j++){ if(j===ridx) continue; var rr=rows[j]; var rtop = rr[ C['상위지역ID(부모ID)'] ] || rr[ C['지역ID'] ]; if(rtop!==topKey) continue; var choices = [].concat(parse(rr[scriptIdx]||''), parse(rr[succIdx]||''), parse(rr[failIdx]||'')).filter(function(x){ return x && x!=='이동한다'; }); for(var k=0;k<choices.length;k++){ var ch=choices[k]; if(ch===name) return false; if(nameToIdByRegion[topKey] && nameToIdByRegion[topKey][ch] && nameToIdByRegion[topKey][ch]===regionId) return false; } }
      for(var topId in DATA.regionsTree){ var tree = DATA.regionsTree[topId]; if(!tree||!tree.clusters) continue; for(var ci=0;ci<tree.clusters.length;ci++){ var cluster = tree.clusters[ci]; if(cluster.root === regionId) return false; if(cluster.nodeIds && cluster.nodeIds.indexOf(regionId)!==-1) return false; } }
      return true;
    }catch(e){ console.error('isActuallyOrphan', e); return true; }
  }

  function repairOrphanClassesAfterRender(){ try{ document.querySelectorAll('.canvasNode').forEach(function(el){ var rid = el.getAttribute('data-nodeid') || el.getAttribute('data-rowid') || el.getAttribute('data-regionid') || el.id; if(!rid) return; if(isActuallyOrphan(rid)) el.classList.add('orphanNode'); else el.classList.remove('orphanNode'); }); }catch(e){ console.error('repairOrphanClassesAfterRender', e); } }

  function postInitHooks(){ ensureGraphLockButton(); attachCanvasNodeClickHandlers(); setTimeout(repairOrphanClassesAfterRender, 400); }

  if(window.render && typeof window.render === 'function'){ var orig = window.render; window.render = function(){ var r = orig.apply(this, arguments); try{ postInitHooks(); }catch(e){} return r; }; } else { document.addEventListener('DOMContentLoaded', function(){ setTimeout(postInitHooks, 600); }); setTimeout(postInitHooks, 1000); }

  // Project title sync
  function escapeHtml(s){ return String(s||'').replace(/[&<>"']/g, function(m){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]; }); }
  function updateProjectListDom(){ var pl=document.getElementById('projectList'); if(!pl) return; pl.innerHTML=''; Object.keys(PROJECTS||{}).forEach(function(pid){ var p=PROJECTS[pid]||{}; var row=document.createElement('div'); row.className='projectRow'+(pid===ACTIVE_PROJECT_ID? ' current':''); row.dataset.projectId=pid; var name=escapeHtml(p.name||''); var updated = p.updatedAt? ('<div class="prMeta">'+escapeHtml(new Date(p.updatedAt).toLocaleString())+'</div>') : ''; row.innerHTML = '<div class="prBody"><div class="prName">'+name+'</div>'+updated+'</div>'; pl.appendChild(row); }); }
  function onToolTitleInput(){ var inp=document.getElementById('toolTitleInput'); if(!inp) return; inp.addEventListener('input', function(){ var v=this.value||''; try{ if(typeof DATA!=='undefined') DATA.toolTitle = v; if(typeof PROJECTS!=='undefined' && typeof PROJECT_ID!=='undefined' && PROJECTS[PROJECT_ID]){ PROJECTS[PROJECT_ID].name=v; PROJECTS[PROJECT_ID].updatedAt = Date.now(); } try{ if(typeof PROJECTS_KEY!=='undefined' && typeof localStorage!=='undefined') localStorage.setItem(PROJECTS_KEY, JSON.stringify(PROJECTS)); if(typeof ACTIVE_PROJECT_KEY!=='undefined' && typeof localStorage!=='undefined') localStorage.setItem(ACTIVE_PROJECT_KEY, PROJECT_ID); }catch(e){} if(typeof rebuildProjectView === 'function'){ try{ rebuildProjectView(); }catch(e){ updateProjectListDom(); } } else updateProjectListDom(); }catch(err){ console.error('onToolTitleInput', err); } }); }
  function ensureTitleSyncReady(){ if(typeof PROJECTS==='undefined' || typeof PROJECT_ID==='undefined'){ setTimeout(ensureTitleSyncReady, 400); return; } onToolTitleInput(); var ti=document.getElementById('toolTitleInput'); if(ti){ try{ if(PROJECTS[PROJECT_ID] && PROJECTS[PROJECT_ID].name){ ti.value = PROJECTS[PROJECT_ID].name; DATA.toolTitle = ti.value; } else if(DATA && DATA.toolTitle){ ti.value = DATA.toolTitle; } }catch(e){} } if(typeof rebuildProjectView === 'function') try{ rebuildProjectView(); }catch(e){ updateProjectListDom(); } else updateProjectListDom(); }
  if(document.readyState==='complete' || document.readyState==='interactive'){ setTimeout(ensureTitleSyncReady, 300); } else document.addEventListener('DOMContentLoaded', function(){ setTimeout(ensureTitleSyncReady, 300); });

  window.__graphTools = { lock:function(v){ graphLocked = v===undefined? true: !!v; var b=document.getElementById('btnGraphLock'); if(b){ b.textContent = graphLocked? '그래프 잠금 ✓' : '그래프 잠금 ▸'; b.classList.toggle('primary', graphLocked); } }, unlock:function(){ this.lock(false); }, highlight:function(regionId){ if(!regionId){ clearAllHighlights(); return; } var idx = rowById && rowById[regionId]!=null? rowById[regionId] : -1; if(idx===-1){ for(var i=0;i<DATA.sheet1.rows.length;i++) if(DATA.sheet1.rows[i][C['지역ID']]==regionId) { idx=i; break; } } if(idx===-1) return; var linked = getLinkedNodeIdsByRow(idx); applyHighlight(regionId, linked.prev, linked.next); }, repairOrphans: repairOrphanClassesAfterRender };

})();
</script>
