// graph-enhancements.js
// Adds: graph lock toggle, node selection highlighting (prev/next), fix orphan detection
(function(){
  'use strict';
  // Expose a single function to integrate into existing app: initGraphEnhancements(bindings)
  // bindings: { getNodes, getEdges, renderNodes, markDirty, openNodePanel }

  function initGraphEnhancements(bindings){
    if(!bindings) throw new Error('bindings required');
    var state = {
      locked: false,
      selectedNode: null
    };

    // Add toolbar buttons
    function createToolbar(){
      var wrap = document.createElement('div');
      wrap.className = 'canvasToolbar';
      var lockBtn = document.createElement('button');
      lockBtn.textContent = '🔒 잠금';
      lockBtn.title = '그래프 잠금/해제 (노드 이동 차단)';
      lockBtn.addEventListener('click', function(){ state.locked = !state.locked; updateLockBtn(); });

      var clearSel = document.createElement('button');
      clearSel.textContent = '선택 해제';
      clearSel.addEventListener('click', function(){ selectNode(null); });

      wrap.appendChild(lockBtn);
      wrap.appendChild(clearSel);
      return {el:wrap, lockBtn:lockBtn};
    }

    var toolbarMeta = createToolbar();
    var parent = document.getElementById('main');
    if(parent){ parent.insertBefore(toolbarMeta.el, parent.firstChild); }

    function updateLockBtn(){
      toolbarMeta.lockBtn.textContent = state.locked ? '🔓 잠금 해제' : '🔒 잠금';
      toolbarMeta.lockBtn.classList.toggle('swapModeActive', state.locked);
    }

    // Node click handling (delegated)
    function attachNodeHandlers(){
      var wrap = document.getElementById('clusterCanvasInner') || document.getElementById('clusterCanvasWrap');
      if(!wrap) return;
      wrap.addEventListener('click', function(ev){
        var nodeEl = ev.target.closest && ev.target.closest('.canvasNode');
        if(nodeEl){
          var id = nodeEl.getAttribute('data-node-id');
          selectNode(id);
          // open panel if double-click
          if(ev.detail===2 && bindings.openNodePanel) bindings.openNodePanel(id);
        }
      });

      // prevent dragging when locked: intercept mousedown on nodes
      wrap.addEventListener('mousedown', function(ev){
        if(!state.locked) return; // no-op
        var nodeEl = ev.target.closest && ev.target.closest('.canvasNode');
        if(nodeEl){
          ev.stopPropagation();
          ev.preventDefault();
        }
      }, true);
    }

    // Highlighting helpers
    function clearHighlights(){
      document.querySelectorAll('.canvasNode').forEach(function(n){ n.classList.remove('g-selected','g-prev','g-next'); });
      document.querySelectorAll('.canvasEdge').forEach(function(e){ e.classList.remove('g-highlight'); });
    }
    function selectNode(id){
      state.selectedNode = id;
      clearHighlights();
      if(!id) return;
      var nodes = bindings.getNodes(); // [{id,prev:[],next:[],el}]
      var map = {};
      nodes.forEach(function(n){ map[n.id]=n; });
      var sel = map[id];
      if(!sel) return;
      // mark selected
      var selEl = document.querySelector('.canvasNode[data-node-id="'+id+'"]');
      if(selEl) selEl.classList.add('g-selected');
      // prev
      sel.prev && sel.prev.forEach(function(pid){
        var pEl = document.querySelector('.canvasNode[data-node-id="'+pid+'"]');
        if(pEl) pEl.classList.add('g-prev');
      });
      // next
      sel.next && sel.next.forEach(function(nid){
        var nEl = document.querySelector('.canvasNode[data-node-id="'+nid+'"]');
        if(nEl) nEl.classList.add('g-next');
      });
      // edge highlight
      document.querySelectorAll('.canvasEdge').forEach(function(e){
        var a = e.getAttribute('data-from'), b = e.getAttribute('data-to');
        if(a===id || b===id || (sel.prev && sel.prev.indexOf(a)!==-1 && b===id) || (sel.next && sel.next.indexOf(b)!==-1 && a===id)){
          e.classList.add('g-highlight');
        }
      });
    }

    // Fix orphan classification: recalculate using edges rather than cluster heuristics
    function fixOrphans(){
      var nodes = bindings.getNodes();
      var edges = bindings.getEdges();
      var hasIn = {}, hasOut = {};
      edges.forEach(function(ed){ hasOut[ed.from]=true; hasIn[ed.to]=true; });
      nodes.forEach(function(n){
        var el = document.querySelector('.canvasNode[data-node-id="'+n.id+'"]');
        if(!el) return;
        // orphan if no in and no out
        if(!hasIn[n.id] && !hasOut[n.id]){
          el.classList.add('orphanNode');
        } else {
          el.classList.remove('orphanNode');
        }
      });
    }

    // wire into render pipeline by replacing renderNodes if provided, otherwise poll
    if(bindings.renderNodes){
      var origRender = bindings.renderNodes;
      bindings.renderNodes = function(){ origRender.apply(null, arguments); setTimeout(function(){ fixOrphans(); attachNodeHandlers(); },0); };
    } else {
      // try attach once
      setTimeout(function(){ attachNodeHandlers(); fixOrphans(); },500);
    }

    // add styles
    var css = '\n.canvasNode.g-selected{box-shadow:0 8px 24px rgba(52,87,213,.28);border-color:var(--accent);transform:translateY(-2px);}\n' +
              '.canvasNode.g-prev{outline:3px solid rgba(52,87,213,.18);outline-offset:4px;}\n' +
              '.canvasNode.g-next{outline:3px solid rgba(46,204,113,.15);outline-offset:4px;}\n' +
              '.canvasEdge.g-highlight{stroke:var(--accent);stroke-width:2.6;}\n';
    var s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);

    return {
      state: state,
      selectNode: selectNode,
      fixOrphans: fixOrphans
    };
  }

  // expose to window
  window.initGraphEnhancements = initGraphEnhancements;
})();
