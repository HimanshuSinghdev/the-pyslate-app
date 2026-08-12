(function(){
  "use strict";

  /* ---------------- CodeMirror setup ---------------- */
  const DEFAULT_CODE = "# Write your Python code here\nprint(\"Hello, World!\")\n";

  const editor = CodeMirror.fromTextArea(document.getElementById('code-editor'), {
    mode: 'python',
    theme: 'pyslate',
    lineNumbers: true,
    indentUnit: 4,
    tabSize: 4,
    indentWithTabs: false,
    styleActiveLine: true,
    autoCloseBrackets: true,
    matchBrackets: true,
    lineWrapping: false,
    extraKeys: {
      "Enter": "newlineAndIndent",
      "Tab": function(cm){
        if(cm.somethingSelected()) cm.execCommand('indentMore');
        else cm.replaceSelection('    ', 'end');
      },
      "Shift-Tab": "indentLess",
      "Backspace": function(cm){
        if(cm.somethingSelected()){ cm.execCommand('delCharBefore'); return; }
        // Deleting through leading indentation removes a full 4-space "level"
        // at a time, so backspace behaves the way Python coders expect.
        const cur = cm.getCursor();
        const before = cm.getRange({line: cur.line, ch: 0}, cur);
        if(before.length > 0 && /^ +$/.test(before) && before.length % 4 === 0){
          cm.execCommand('delCharBefore');
          cm.execCommand('delCharBefore');
          cm.execCommand('delCharBefore');
          cm.execCommand('delCharBefore');
        } else {
          cm.execCommand('delCharBefore');
        }
      }
    }
  });

  /* ---------------- Symbol / snippet keyboard ---------------- */
  const PAIR_MAP = { '(':')', '[':']', '{':'}', '"':'"', "'":"'" };
  const symbolRow = document.getElementById('symbolRow');
  const snippetRow = document.getElementById('snippetRow');

  const SYMBOLS = [':','(',')','[',']','{','}','"',"'",'=','+','-','*','/','//','%','**','<','>','<=','>=','==','!=','!','&','|','^','~','#','.',',',';','\\','_','@','Tab','↵'];
  const SNIPPETS = ['print()','input()','if :','elif :','else:','for  in :','while :','def ():','return ','class :','import ','True','False','None','len()','range()','#TODO '];

  function insertAtCursor(text, cursorOffset){
    const cur = editor.getCursor();
    editor.replaceRange(text, cur);
    if(typeof cursorOffset === 'number'){
      const newPos = { line: cur.line, ch: cur.ch + text.length + cursorOffset };
      editor.setCursor(newPos);
    }
    editor.focus();
  }

  function makeKey(label, wide, handler){
    const b = document.createElement('div');
    b.className = 'keycap' + (wide ? ' wide' : '');
    b.textContent = label;
    b.addEventListener('click', handler);
    return b;
  }

  SYMBOLS.forEach(sym => {
    let label = sym, wide = false;
    if(sym === 'Tab'){ label = '⇥'; wide = false; }
    symbolRow.appendChild(makeKey(label, wide, () => {
      if(sym === 'Tab'){ insertAtCursor('    '); return; }
      if(sym === '↵'){ editor.execCommand('newlineAndIndent'); editor.focus(); return; }
      if(PAIR_MAP[sym]){
        const close = PAIR_MAP[sym];
        insertAtCursor(sym + close, -1);
        return;
      }
      insertAtCursor(sym);
    }));
  });

  SNIPPETS.forEach(sn => {
    snippetRow.appendChild(makeKey(sn, true, () => {
      let text = sn, offset = null;
      if(sn === 'print()'){ text = 'print()'; offset = -1; }
      else if(sn === 'input()'){ text = 'input()'; offset = -1; }
      else if(sn === 'if :'){ text = 'if '; }
      else if(sn === 'elif :'){ text = 'elif '; }
      else if(sn === 'for  in :'){ text = 'for '; }
      else if(sn === 'while :'){ text = 'while '; }
      else if(sn === "def ():"){ text = 'def name():'; offset = -7; }
      else if(sn === 'len()'){ text = 'len()'; offset = -1; }
      else if(sn === 'range()'){ text = 'range()'; offset = -1; }
      insertAtCursor(text, offset);
    }));
  });

  /* ---------------- Register a custom CodeMirror theme (class hook only) ---------------- */
  editor.getWrapperElement().classList.add('cm-s-pyslate');

  /* ---------------- Format button ---------------- */
  // Lightweight, offline formatter: normalises tabs to spaces, strips trailing
  // whitespace, and re-indents every line using CodeMirror's Python-aware smart
  // indent (matches colons, brackets, dedent keywords, etc). It won't rewrite
  // spacing around operators the way a tool like black does, but it fixes the
  // most common mess — mismatched/broken indentation from typing on a phone.
  document.getElementById('formatBtn').addEventListener('click', () => {
    const cur = editor.getCursor();
    const normalized = editor.getValue()
      .replace(/\t/g, '    ')
      .split('\n')
      .map(l => l.replace(/[ \t]+$/, ''))
      .join('\n');
    editor.setValue(normalized);
    editor.operation(() => {
      for(let i = 0; i < editor.lineCount(); i++){
        editor.indentLine(i, 'smart');
      }
    });
    editor.setCursor({ line: Math.min(cur.line, editor.lineCount() - 1), ch: cur.ch });
    editor.focus();
    saveDraft();
    toast('Formatted');
  });

  /* ---------------- Output helpers ---------------- */
  const outputBox = document.getElementById('outputBox');
  const stdinBox = document.getElementById('stdinBox');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');

  const MAX_OUTPUT_CHARS = 60000; // plenty for a terminal view; guards against runaway print loops
  let outputCharCount = 0;
  let outputTruncated = false;

  function clearOutput(){
    outputBox.innerHTML = '';
    outputCharCount = 0;
    outputTruncated = false;
  }
  function appendOutput(text, cls){
    if(outputTruncated) return;
    if(outputBox.querySelector('.placeholder')) outputBox.innerHTML = '';
    outputCharCount += text.length;
    if(outputCharCount > MAX_OUTPUT_CHARS){
      outputTruncated = true;
      const span = document.createElement('span');
      span.className = 'sys-line';
      span.textContent = '\n⚠ Output stopped — this looks like a runaway loop or deep recursion printing too much. Tap Stop.';
      outputBox.appendChild(span);
      outputBox.scrollTop = outputBox.scrollHeight;
      return;
    }
    const span = document.createElement('span');
    if(cls) span.className = cls;
    span.textContent = text;
    outputBox.appendChild(span);
    outputBox.scrollTop = outputBox.scrollHeight;
  }
  function setStatus(mode, text){
    statusDot.className = 'status-dot' + (mode ? ' ' + mode : '');
    statusText.textContent = text;
  }

  /* ---------------- Turtle canvas rendering ---------------- */
  const turtlePanel = document.getElementById('turtlePanel');
  const turtleCanvas = document.getElementById('turtleCanvas');
  const turtleCtx = turtleCanvas.getContext('2d');
  const T_W = turtleCanvas.width, T_H = turtleCanvas.height;
  const tx = x => T_W / 2 + x;
  const ty = y => T_H / 2 - y;

  function turtleClearCanvas(){
    turtleCtx.fillStyle = '#ffffff';
    turtleCtx.fillRect(0, 0, T_W, T_H);
  }
  function showTurtlePanel(){
    if(turtlePanel.classList.contains('hidden')){
      turtlePanel.classList.remove('hidden');
      turtlePanel.scrollIntoView({behavior:'smooth', block:'nearest'});
    }
  }
  function handleTurtleCmd(d){
    switch(d.op){
      case 'line':
        turtleCtx.strokeStyle = d.color || '#000';
        turtleCtx.lineWidth = d.width || 1;
        turtleCtx.lineCap = 'round';
        turtleCtx.beginPath();
        turtleCtx.moveTo(tx(d.x1), ty(d.y1));
        turtleCtx.lineTo(tx(d.x2), ty(d.y2));
        turtleCtx.stroke();
        break;
      case 'dot':
        turtleCtx.fillStyle = d.color || '#000';
        turtleCtx.beginPath();
        turtleCtx.arc(tx(d.x), ty(d.y), d.r || 3, 0, Math.PI * 2);
        turtleCtx.fill();
        break;
      case 'text':
        turtleCtx.fillStyle = d.color || '#000';
        turtleCtx.font = '14px monospace';
        turtleCtx.fillText(d.text, tx(d.x), ty(d.y));
        break;
      case 'polygon':
        if(d.points && d.points.length > 1){
          turtleCtx.fillStyle = d.color || '#000';
          turtleCtx.beginPath();
          turtleCtx.moveTo(tx(d.points[0][0]), ty(d.points[0][1]));
          for(let i = 1; i < d.points.length; i++) turtleCtx.lineTo(tx(d.points[i][0]), ty(d.points[i][1]));
          turtleCtx.closePath();
          turtleCtx.fill();
        }
        break;
      case 'bgcolor':
        turtleCtx.fillStyle = d.color || '#fff';
        turtleCtx.fillRect(0, 0, T_W, T_H);
        break;
    }
  }
  turtleClearCanvas();

  /* ---------------- Live-input support (SharedArrayBuffer + Atomics) ---------------- */
  const inputHint = document.getElementById('inputHint');
  const LIVE_INPUT_SUPPORTED = (typeof SharedArrayBuffer !== 'undefined') && !!self.crossOriginIsolated;
  let sab = null;
  let sabInts = null;
  if(LIVE_INPUT_SUPPORTED){
    sab = new SharedArrayBuffer(8 + 8192); // 2 int32 header + 8192 byte payload
    sabInts = new Int32Array(sab, 0, 2);
    inputHint.textContent = 'live — pauses & prompts you here';
  } else {
    inputHint.textContent = 'fill this in before Run (live prompts unavailable)';
  }

  /* ---------------- Worker (Pyodide runtime) ---------------- */
  let worker = null;
  let runtimeReady = false;
  let runStart = 0;
  let awaitingInput = false;
  let isRunning = false;

  function spawnWorker(){
    runtimeReady = false;
    awaitingInput = false;
    isRunning = false;
    outputBox.classList.remove('awaiting');
    const staleRow = outputBox.querySelector('.input-request-row');
    if(staleRow) staleRow.remove();
    if(worker){ try{ worker.terminate(); }catch(e){} }
    worker = new Worker('./js/worker.js');
    worker.onmessage = onWorkerMessage;
    worker.onerror = function(e){
      setStatus('err', 'Runtime error — tap Run to retry');
      runBtn.disabled = false;
      isRunning = false;
    };
    worker.postMessage({type:'init', sab: sab});
    setStatus('busy', 'Booting Python runtime…');
    runBtn.disabled = true;
  }

  function showInputRequest(promptText){
    awaitingInput = true;
    outputBox.classList.add('awaiting');
    setStatus('busy', 'Waiting for your input…');
    if(promptText) appendOutput(promptText);
    const row = document.createElement('div');
    row.className = 'input-request-row';
    row.innerHTML = '<span class="flag">▸ enter input</span><input type="text" autocomplete="off" autocapitalize="off" spellcheck="false"><button type="button">Send ⏎</button>';
    outputBox.appendChild(row);
    outputBox.scrollTop = outputBox.scrollHeight;
    const field = row.querySelector('input');
    const sendBtn = row.querySelector('button');
    field.focus();

    function submit(){
      if(!awaitingInput) return;
      const text = field.value;
      row.remove();
      appendOutput(text + '\n', 'echo-line');
      outputBox.classList.remove('awaiting');
      awaitingInput = false;
      setStatus('busy', 'Running…');

      const bytes = new TextEncoder().encode(text).slice(0, 8192);
      const payloadView = new Uint8Array(sab, 8, 8192);
      payloadView.set(bytes);
      Atomics.store(sabInts, 1, bytes.length);
      Atomics.store(sabInts, 0, 2); // 2 = answered
      Atomics.notify(sabInts, 0);
    }
    field.addEventListener('keydown', (ev) => { if(ev.key === 'Enter'){ ev.preventDefault(); submit(); } });
    sendBtn.addEventListener('click', submit);
  }

  function onWorkerMessage(e){
    const data = e.data;
    if(data.type === 'ready'){
      runtimeReady = true;
      runBtn.disabled = false;
      setStatus('ok', 'Ready');
    } else if(data.type === 'init-error'){
      setStatus('err', 'Could not load Python runtime — check connection');
    } else if(data.type === 'input-request'){
      showInputRequest(data.prompt);
    } else if(data.type === 'stdout'){
      appendOutput(data.text);
    } else if(data.type === 'stderr'){
      appendOutput(data.text, 'err-line');
    } else if(data.type === 'done'){
      const ms = Math.round(performance.now() - runStart);
      setStatus('ok', 'Finished in ' + ms + ' ms');
      runBtn.disabled = false;
      isRunning = false;
    } else if(data.type === 'run-error'){
      // The friendly traceback was already streamed via stderr — just reflect status.
      setStatus('err', 'Error in your code — see output');
      runBtn.disabled = false;
      isRunning = false;
    } else if(data.type === 'error'){
      appendOutput('\n' + data.message, 'err-line');
      setStatus('err', 'Error');
      runBtn.disabled = false;
      isRunning = false;
    } else if(data.type === 'installing'){
      setStatus('busy', 'Installing ' + data.packages.join(', ') + '…');
    } else if(data.type === 'install-failed'){
      toast("Couldn't install '" + data.package + "' — continuing without it");
    } else if(data.type === 'turtle-show'){
      showTurtlePanel();
    } else if(data.type === 'turtle-clear'){
      turtleClearCanvas();
    } else if(data.type === 'turtle-cmd'){
      handleTurtleCmd(data);
    } else if(data.type === 'image'){
      const img = document.createElement('img');
      img.src = 'data:image/png;base64,' + data.data;
      img.alt = 'plot output';
      outputBox.appendChild(img);
      outputBox.scrollTop = outputBox.scrollHeight;
    }
  }

  /* ---------------- Run / Stop / Clear ---------------- */
  const runBtn = document.getElementById('runBtn');
  const stopBtn = document.getElementById('stopBtn');
  const clearBtn = document.getElementById('clearBtn');

  runBtn.addEventListener('click', () => {
    if(!runtimeReady || runBtn.disabled) return;
    if(!LIVE_INPUT_SUPPORTED && /\binput\s*\(/.test(editor.getValue()) && !stdinBox.value.trim()){
      toast('Your script calls input() — add a value per line in the Input panel first');
      stdinBox.focus();
      return;
    }
    clearOutput();
    turtlePanel.classList.add('hidden');
    turtleClearCanvas();
    const code = editor.getValue();
    let raw = stdinBox.value;
    if(raw.endsWith('\n')) raw = raw.slice(0, -1); // avoid a phantom blank final answer
    const input = raw.length ? raw.split('\n') : [];
    runStart = performance.now();
    runBtn.disabled = true;
    isRunning = true;
    setStatus('busy', 'Running…');
    worker.postMessage({type:'run', code: code, input: input});
  });

  stopBtn.addEventListener('click', () => {
    if(!isRunning && !awaitingInput){
      toast('Nothing is running right now');
      return;
    }
    appendOutput('\n— stopped —\n', 'sys-line');
    spawnWorker();
  });

  clearBtn.addEventListener('click', () => {
    if(awaitingInput || isRunning){
      spawnWorker(); // cancels any pending run / input prompt cleanly
    }
    outputBox.innerHTML = '<span class="placeholder">Run your script to see output here.</span>';
    setStatus('ok', 'Cleared');
  });

  /* ---------------- Toast ---------------- */
  let toastTimer = null;
  function toast(msg){
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
  }

  /* ---------------- Projects (localStorage) ---------------- */
  const STORE_KEY = 'pyslate.projects.v1';
  const DRAFT_KEY = 'pyslate.draft.v1';
  let currentProjectId = null;
  const projNameLabel = document.getElementById('projNameLabel');

  function loadProjects(){
    try{ return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); }
    catch(e){ return {}; }
  }
  function persistProjects(obj){
    localStorage.setItem(STORE_KEY, JSON.stringify(obj));
  }
  function saveDraft(){
    try{
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        code: editor.getValue(),
        stdin: stdinBox.value,
        projectId: currentProjectId
      }));
    }catch(e){}
  }
  function loadDraft(){
    try{ return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); }
    catch(e){ return null; }
  }

  function setCurrentProject(id, name){
    currentProjectId = id;
    projNameLabel.textContent = name || 'untitled';
  }

  function doSave(name){
    const projects = loadProjects();
    let id = currentProjectId;
    if(!id || !projects[id]){
      id = 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2,7);
    }
    projects[id] = {
      name: name || (projects[id] ? projects[id].name : 'untitled'),
      code: editor.getValue(),
      stdin: stdinBox.value,
      updatedAt: Date.now()
    };
    persistProjects(projects);
    setCurrentProject(id, projects[id].name);
    saveDraft();
    toast('Saved “' + projects[id].name + '”');
  }

  const saveBtn = document.getElementById('saveBtn');
  const saveModalBackdrop = document.getElementById('saveModalBackdrop');
  const saveNameInput = document.getElementById('saveNameInput');
  const confirmSaveBtn = document.getElementById('confirmSaveBtn');
  let pendingSaveName = '';

  saveBtn.addEventListener('click', () => {
    const projects = loadProjects();
    if(currentProjectId && projects[currentProjectId]){
      doSave(projects[currentProjectId].name);
    } else {
      saveNameInput.value = pendingSaveName || '';
      saveModalBackdrop.classList.remove('hidden');
      setTimeout(() => { saveNameInput.focus(); saveNameInput.select(); }, 50);
    }
  });
  confirmSaveBtn.addEventListener('click', () => {
    const name = saveNameInput.value.trim() || 'untitled script';
    doSave(name);
    saveModalBackdrop.classList.add('hidden');
  });

  document.getElementById('newBtn').addEventListener('click', () => {
    if(editor.getValue().trim() && !confirm('Start a new script? Unsaved changes will be lost unless already saved.')) return;
    editor.setValue('');
    stdinBox.value = '';
    setCurrentProject(null, null);
    pendingSaveName = '';
    clearBtn.click();
    saveDraft();
    editor.focus();
  });

  const openFileBtn = document.getElementById('openFileBtn');
  const openFileInput = document.getElementById('openFileInput');
  openFileBtn.addEventListener('click', () => {
    if(editor.getValue().trim() && !confirm('Open a file? Unsaved changes in the current script will be lost unless already saved.')) return;
    openFileInput.value = '';
    openFileInput.click();
  });
  openFileInput.addEventListener('change', () => {
    const file = openFileInput.files && openFileInput.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      editor.setValue(String(reader.result || ''));
      stdinBox.value = '';
      const baseName = file.name.replace(/\.py$/i, '');
      setCurrentProject(null, baseName); // shows the filename, but isn't yet a saved project
      pendingSaveName = baseName;
      clearBtn.click();
      saveDraft();
      toast('Opened ' + file.name + ' — tap Save to keep it as a project');
    };
    reader.onerror = () => toast('Could not read that file');
    reader.readAsText(file);
  });

  document.getElementById('downloadBtn').addEventListener('click', () => {
    const projects = loadProjects();
    const name = (currentProjectId && projects[currentProjectId]) ? projects[currentProjectId].name : 'script';
    const safeName = (name.replace(/[^a-z0-9_\-]+/gi, '_') || 'script') + '.py';
    const blob = new Blob([editor.getValue()], {type:'text/plain'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = safeName;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Delay revoking the object URL — some mobile browsers process the
    // download asynchronously, and revoking too early breaks it.
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('Downloading ' + safeName);
  });

  /* ---------------- Projects modal ---------------- */
  const projectsBtn = document.getElementById('projectsBtn');
  const projectsModalBackdrop = document.getElementById('projectsModalBackdrop');
  const projList = document.getElementById('projList');

  function renderProjectsList(){
    const projects = loadProjects();
    const ids = Object.keys(projects).sort((a,b) => projects[b].updatedAt - projects[a].updatedAt);
    projList.innerHTML = '';
    if(ids.length === 0){
      projList.innerHTML = '<div class="empty-note">No saved projects yet.<br>Write some code and tap Save.</div>';
      return;
    }
    ids.forEach(id => {
      const p = projects[id];
      const item = document.createElement('div');
      item.className = 'proj-item';
      const d = new Date(p.updatedAt);
      const dateStr = d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
      item.innerHTML =
        '<div class="meta">' +
          '<div class="p-name"></div>' +
          '<div class="p-date">' + dateStr + '</div>' +
        '</div>' +
        '<div class="p-actions">' +
          '<button class="rename" title="Rename">✎</button>' +
          '<button class="danger delete" title="Delete">🗑</button>' +
        '</div>';
      item.querySelector('.p-name').textContent = p.name;
      item.querySelector('.meta').addEventListener('click', () => {
        editor.setValue(p.code || '');
        stdinBox.value = p.stdin || '';
        setCurrentProject(id, p.name);
        saveDraft();
        projectsModalBackdrop.classList.add('hidden');
        clearBtn.click();
        toast('Opened “' + p.name + '”');
      });
      item.querySelector('.rename').addEventListener('click', (ev) => {
        ev.stopPropagation();
        const newName = prompt('Rename project', p.name);
        if(newName && newName.trim()){
          const projects2 = loadProjects();
          projects2[id].name = newName.trim();
          persistProjects(projects2);
          if(currentProjectId === id) projNameLabel.textContent = newName.trim();
          renderProjectsList();
        }
      });
      item.querySelector('.delete').addEventListener('click', (ev) => {
        ev.stopPropagation();
        if(confirm('Delete “' + p.name + '”? This cannot be undone.')){
          const projects2 = loadProjects();
          delete projects2[id];
          persistProjects(projects2);
          if(currentProjectId === id) setCurrentProject(null, null);
          renderProjectsList();
        }
      });
      projList.appendChild(item);
    });
  }

  projectsBtn.addEventListener('click', () => {
    renderProjectsList();
    projectsModalBackdrop.classList.remove('hidden');
  });

  document.querySelectorAll('[data-close]').forEach(el => {
    el.addEventListener('click', () => {
      document.getElementById(el.getAttribute('data-close')).classList.add('hidden');
    });
  });

  /* ---------------- Autosave draft ---------------- */
  let draftTimer = null;
  editor.on('change', () => { clearTimeout(draftTimer); draftTimer = setTimeout(saveDraft, 500); });
  stdinBox.addEventListener('input', () => { clearTimeout(draftTimer); draftTimer = setTimeout(saveDraft, 500); });

  /* ---------------- PWA: install support + auto-updating shell ---------------- */
  // On hosts that support real response headers (Netlify, via the _headers file),
  // crossOriginIsolated is already true on first load and none of this matters.
  // On hosts that can't set custom headers (GitHub Pages), the service worker
  // injects the COOP/COEP headers itself — but that only takes effect once the
  // SW is actually controlling the page, so we reload exactly once to pick it up.
  if('serviceWorker' in navigator){
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./service-worker.js').then(() => {
        if(window.crossOriginIsolated){
          sessionStorage.removeItem('pyslate_coi_reload');
          return;
        }
        if(sessionStorage.getItem('pyslate_coi_reload')) return; // already tried, avoid a reload loop
        const reloadOnce = () => {
          sessionStorage.setItem('pyslate_coi_reload', '1');
          window.location.reload();
        };
        if(navigator.serviceWorker.controller){
          reloadOnce();
        } else {
          navigator.serviceWorker.addEventListener('controllerchange', reloadOnce, {once:true});
        }
      }).catch(() => {});
    });
  }

  /* ---------------- Credit line typewriter ---------------- */
  function typeCredit(){
    const el = document.getElementById('creditText');
    if(!el) return;
    const text = 'Made by Himanshu';
    let i = 0;
    (function step(){
      el.textContent = text.slice(0, i);
      i++;
      if(i <= text.length) setTimeout(step, 65);
    })();
  }

  /* ---------------- Init ---------------- */
  (function init(){
    const draft = loadDraft();
    if(draft && (draft.code || draft.stdin)){
      editor.setValue(draft.code || '');
      stdinBox.value = draft.stdin || '';
      if(draft.projectId){
        const projects = loadProjects();
        if(projects[draft.projectId]) setCurrentProject(draft.projectId, projects[draft.projectId].name);
      }
    } else {
      editor.setValue(DEFAULT_CODE);
    }
    spawnWorker();
    setTimeout(() => editor.refresh(), 50);
    setTimeout(typeCredit, 300);
  })();

})();
