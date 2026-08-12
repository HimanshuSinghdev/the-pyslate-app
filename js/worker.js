const HEADER_INTS = 2;      // [0]=status (0 idle,1 waiting,2 answered), [1]=byte length of answer
const PAYLOAD_BYTES = 8192; // max characters (UTF-8 bytes) per input() answer
let sync = null;    // Int32Array view over the shared buffer
let payload = null; // Uint8Array view over the shared buffer

function requestInputSyncLive(promptText){
  Atomics.store(sync, 1, 0);
  Atomics.store(sync, 0, 1); // 1 = waiting for main thread
  self.postMessage({type:'input-request', prompt: promptText || ''});
  Atomics.wait(sync, 0, 1);  // blocks THIS worker thread only, page stays responsive
  const len = Atomics.load(sync, 1);
  const bytes = payload.slice(0, len);
  Atomics.store(sync, 0, 0); // reset to idle
  return new TextDecoder().decode(bytes);
}

// Turtle graphics bridge: Python turtle shim calls these; they just forward
// draw commands to the main thread, which owns the actual <canvas>. No need
// to block — the page renders them as they arrive.
function _turtleShow(){ self.postMessage({type:'turtle-show'}); }
function _turtleClear(){ self.postMessage({type:'turtle-clear'}); }
function _turtleLine(x1,y1,x2,y2,color,width){ self.postMessage({type:'turtle-cmd', op:'line', x1,y1,x2,y2,color,width}); }
function _turtleDot(x,y,r,color){ self.postMessage({type:'turtle-cmd', op:'dot', x,y,r,color}); }
function _turtleText(x,y,text,color){ self.postMessage({type:'turtle-cmd', op:'text', x,y,text,color}); }
function _turtleBgcolor(color){ self.postMessage({type:'turtle-cmd', op:'bgcolor', color}); }
function _turtlePolygon(pointsProxy, color){
  const points = (pointsProxy && pointsProxy.toJs) ? pointsProxy.toJs() : pointsProxy;
  if(pointsProxy && pointsProxy.destroy) pointsProxy.destroy();
  self.postMessage({type:'turtle-cmd', op:'polygon', points, color});
}

self.onmessage = async function(e){
  const data = e.data;
  if(data.type === 'init'){
    try{
      if(data.sab){
        sync = new Int32Array(data.sab, 0, HEADER_INTS);
        payload = new Uint8Array(data.sab, HEADER_INTS * 4, PAYLOAD_BYTES);
      }
      importScripts('https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js');
      self.pyodide = await loadPyodide();
      self.postMessage({type:'ready', liveInput: !!data.sab});
    }catch(err){
      self.postMessage({type:'init-error', message: String(err)});
    }
    return;
  }
  if(data.type === 'run'){
    const pyodide = self.pyodide;
    try{
      pyodide.setStdout({ batched: (s) => self.postMessage({type:'stdout', text:s}) });
      pyodide.setStderr({ batched: (s) => self.postMessage({type:'stderr', text:s}) });

      let setup;
      if(sync){
        // Live mode: input() genuinely pauses this worker and signals the page to prompt the user.
        pyodide.globals.set('_request_input_sync', requestInputSyncLive);
        setup = [
          "import builtins as _b",
          "def _pyslate_input(prompt=''):",
          "    return _request_input_sync(prompt)",
          "_b.input = _pyslate_input"
        ].join("\n");
      } else {
        // Fallback mode (no cross-origin isolation available): read pre-filled Input panel lines.
        pyodide.globals.set('_INPUT_LINES', pyodide.toPy(data.input || []));
        setup = [
          "import builtins as _b",
          "_input_lines = list(_INPUT_LINES)",
          "_input_index = 0",
          "def _pyslate_input(prompt=''):",
          "    global _input_index",
          "    if prompt:",
          "        print(prompt, end='')",
          "    if _input_index < len(_input_lines):",
          "        _v = _input_lines[_input_index]",
          "        _input_index += 1",
          "        print(_v)",
          "        return _v",
          "    raise EOFError('input() was called but the Input panel has no more lines. Add a value above (one per line) and Run again.')",
          "_b.input = _pyslate_input"
        ].join("\n");
      }

      // Beginner-friendly error reporting: run the user's code through a wrapper
      // that trims the traceback down to their own lines (no Pyodide/JS internals)
      // and adds a plain-English hint for common mistake types.
      setup += "\n" + [
        "import sys, linecache, traceback",
        "_HINTS = {",
        "    'NameError': \"A name isn't defined yet — check spelling, and that it's created before this line runs.\",",
        "    'IndentationError': 'Python cares about spacing — lines in the same block need matching indentation (4 spaces is standard).',",
        "    'TabError': 'This line mixes tabs and spaces for indentation — stick to one (4 spaces is standard).',",
        "    'SyntaxError': 'There is a typo in the code structure — check for missing colons, quotes, brackets, or parentheses.',",
        "    'TypeError': \"A value was used in a way its type doesn't support — e.g. mixing text and numbers without converting.\",",
        "    'ZeroDivisionError': 'You divided a number by zero, which is not allowed.',",
        "    'IndexError': 'You tried to access a list/string position that does not exist — check its length first.',",
        "    'KeyError': 'That key is not in the dictionary — check spelling, or use .get() to avoid this.',",
        "    'ValueError': \"The value passed in isn't right for what was expected — e.g. converting text that isn't a number.\",",
        "    'AttributeError': 'That object does not have the method/property you called — check spelling and the object type.',",
        "    'ModuleNotFoundError': 'That module is not available in this browser-based Python — only certain built-in packages work here.',",
        "    'EOFError': 'input() ran out of values — check the Input panel has one line per input() call.',",
        "    'RecursionError': 'A function kept calling itself with no way to stop — check the base case of your recursion.',",
        "}",
        "def _pyslate_hint(name):",
        "    tip = _HINTS.get(name)",
        "    return ('\\n  \\u2192 tip: ' + tip) if tip else ''",
        "def _pyslate_print_syntax_error(e):",
        "    print('\\n\\u2717 Syntax error \u2014 line %s' % (e.lineno or '?'), file=sys.stderr)",
        "    if e.text:",
        "        print('    ' + e.text.rstrip(), file=sys.stderr)",
        "        if e.offset:",
        "            print('    ' + ' ' * max(0, e.offset - 1) + '^', file=sys.stderr)",
        "    print(e.msg + _pyslate_hint('SyntaxError'), file=sys.stderr)",
        "def _pyslate_print_runtime_error(e):",
        "    tb = traceback.extract_tb(e.__traceback__)",
        "    user_frames = [f for f in tb if f.filename == '<script>']",
        "    print('\\n\\u2717 Traceback (your code):', file=sys.stderr)",
        "    i, n, shown, MAX_SHOWN = 0, len(user_frames), 0, 8",
        "    while i < n and shown < MAX_SHOWN:",
        "        f = user_frames[i]",
        "        j = i",
        "        while j < n and user_frames[j].lineno == f.lineno and user_frames[j].name == f.name:",
        "            j += 1",
        "        count = j - i",
        "        line_txt = (f.line or '').strip()",
        "        loc = '    line %s, in %s' % (f.lineno, f.name)",
        "        print(loc + (': ' + line_txt if line_txt else ''), file=sys.stderr)",
        "        shown += 1",
        "        if count > 1:",
        "            print('    ... repeated %d more times ...' % (count - 1), file=sys.stderr)",
        "        i = j",
        "    if i < n:",
        "        print('    ... (%d more frames not shown) ...' % (n - i), file=sys.stderr)",
        "    ename = type(e).__name__",
        "    print('%s: %s' % (ename, e) + _pyslate_hint(ename), file=sys.stderr)",
        "def _pyslate_run(source):",
        "    linecache.cache['<script>'] = (len(source), None, source.splitlines(keepends=True), '<script>')",
        "    try:",
        "        _compiled = compile(source, '<script>', 'exec')",
        "    except SyntaxError as e:",
        "        _pyslate_print_syntax_error(e)",
        "        return False",
        "    try:",
        "        exec(_compiled, {'__name__': '__main__'})",
        "    except Exception as e:",
        "        _pyslate_print_runtime_error(e)",
        "        return False",
        "    return True"
      ].join("\n");

      // Scan for imports and install anything missing via micropip, build the
      // turtle shim module (real `turtle` doesn't exist in Pyodide — no GUI),
      // and route matplotlib to a non-interactive backend so plt.show() doesn't hang.
      setup += "\n" + [
        "import re as _re",
        "def _pyslate_scan_imports(source):",
        "    names = set()",
        "    for m in _re.finditer(r'^\\s*import\\s+([\\w\\.]+)', source, _re.M):",
        "        names.add(m.group(1).split('.')[0])",
        "    for m in _re.finditer(r'^\\s*from\\s+([\\w\\.]+)\\s+import', source, _re.M):",
        "        names.add(m.group(1).split('.')[0])",
        "    return names",
        "def _pyslate_needed_installs(source):",
        "    try:",
        "        stdlib = set(sys.stdlib_module_names)",
        "    except Exception:",
        "        stdlib = set(sys.builtin_module_names)",
        "    skip = {'turtle'}",
        "    already = set(sys.modules.keys())",
        "    names = _pyslate_scan_imports(source)",
        "    return sorted(n for n in names if n not in stdlib and n not in skip and n not in already)",
        "def _pyslate_build_turtle_module():",
        "    import types, math as _tmath",
        "    def _pyslate_color(c):",
        "        if isinstance(c, (tuple, list)) and len(c) == 3:",
        "            r, g, b = c",
        "            if max(r, g, b) <= 1:",
        "                r, g, b = r * 255, g * 255, b * 255",
        "            return 'rgb(%d,%d,%d)' % (int(r), int(g), int(b))",
        "        return str(c)",
        "    class Turtle:",
        "        def __init__(self):",
        "            self.x = 0.0; self.y = 0.0; self.heading_deg = 0.0",
        "            self.pen_down = True; self.pen_color = 'black'; self.fill_color = 'black'",
        "            self.pen_width = 1; self.visible = True; self.filling = False; self._fill_points = []",
        "            _t_show()",
        "        def _move_to(self, nx, ny):",
        "            if self.pen_down:",
        "                _t_line(self.x, self.y, nx, ny, self.pen_color, self.pen_width)",
        "            if self.filling:",
        "                self._fill_points.append((nx, ny))",
        "            self.x, self.y = nx, ny",
        "        def forward(self, dist):",
        "            rad = _tmath.radians(self.heading_deg)",
        "            self._move_to(self.x + dist * _tmath.cos(rad), self.y + dist * _tmath.sin(rad))",
        "        fd = forward",
        "        def backward(self, dist): self.forward(-dist)",
        "        bk = backward; back = backward",
        "        def right(self, angle): self.heading_deg = (self.heading_deg - angle) % 360",
        "        rt = right",
        "        def left(self, angle): self.heading_deg = (self.heading_deg + angle) % 360",
        "        lt = left",
        "        def penup(self): self.pen_down = False",
        "        pu = penup; up = penup",
        "        def pendown(self): self.pen_down = True",
        "        pd = pendown; down = pendown",
        "        def goto(self, x, y=None):",
        "            if y is None and hasattr(x, '__len__'): x, y = x[0], x[1]",
        "            self._move_to(float(x), float(y))",
        "        setpos = goto; setposition = goto",
        "        def setx(self, x): self._move_to(float(x), self.y)",
        "        def sety(self, y): self._move_to(self.x, float(y))",
        "        def setheading(self, angle): self.heading_deg = float(angle) % 360",
        "        seth = setheading",
        "        def home(self): self._move_to(0.0, 0.0); self.heading_deg = 0.0",
        "        def heading(self): return self.heading_deg",
        "        def position(self): return (self.x, self.y)",
        "        pos = position",
        "        def xcor(self): return self.x",
        "        def ycor(self): return self.y",
        "        def distance(self, x, y=None):",
        "            if y is None and hasattr(x, '__len__'): x, y = x[0], x[1]",
        "            return ((self.x - x) ** 2 + (self.y - y) ** 2) ** 0.5",
        "        def circle(self, radius, extent=None, steps=None):",
        "            extent = 360 if extent is None else extent",
        "            steps = steps or max(int(abs(extent) / 5), 8)",
        "            step_angle = extent / steps",
        "            chord = 2 * abs(radius) * _tmath.sin(_tmath.radians(step_angle) / 2)",
        "            for _ in range(steps):",
        "                self.forward(chord if radius >= 0 else -chord)",
        "                self.left(step_angle if radius >= 0 else -step_angle)",
        "        def dot(self, size=None, color=None):",
        "            size = size or max(self.pen_width + 4, 6)",
        "            _t_dot(self.x, self.y, size / 2, color or self.pen_color)",
        "        def write(self, text, move=False, align='left', font=None):",
        "            _t_text(self.x, self.y, str(text), self.pen_color)",
        "        def color(self, c1=None, c2=None):",
        "            if c1 is not None:",
        "                self.pen_color = _pyslate_color(c1)",
        "                self.fill_color = _pyslate_color(c2) if c2 is not None else self.pen_color",
        "        def pencolor(self, c=None):",
        "            if c is not None: self.pen_color = _pyslate_color(c)",
        "            return self.pen_color",
        "        def fillcolor(self, c=None):",
        "            if c is not None: self.fill_color = _pyslate_color(c)",
        "            return self.fill_color",
        "        def pensize(self, w=None):",
        "            if w is not None: self.pen_width = w",
        "            return self.pen_width",
        "        width = pensize",
        "        def begin_fill(self): self.filling = True; self._fill_points = [(self.x, self.y)]",
        "        def end_fill(self):",
        "            if self.filling and len(self._fill_points) > 2:",
        "                _t_polygon(self._fill_points, self.fill_color)",
        "            self.filling = False; self._fill_points = []",
        "        def speed(self, s=None): pass",
        "        def hideturtle(self): self.visible = False",
        "        ht = hideturtle",
        "        def showturtle(self): self.visible = True",
        "        st = showturtle",
        "        def isdown(self): return self.pen_down",
        "        def clear(self): _t_clear()",
        "        def reset(self):",
        "            _t_clear(); self.x = self.y = 0.0; self.heading_deg = 0.0; self.pen_down = True",
        "    Pen = Turtle",
        "    class Screen:",
        "        def bgcolor(self, c=None):",
        "            if c is not None: _t_bgcolor(_pyslate_color(c))",
        "        def title(self, t): pass",
        "        def setup(self, *a, **k): pass",
        "        def screensize(self, *a, **k): pass",
        "        def tracer(self, *a, **k): pass",
        "        def update(self): pass",
        "        def exitonclick(self): pass",
        "        def listen(self): pass",
        "        def onkey(self, *a, **k): pass",
        "        def onclick(self, *a, **k): pass",
        "        def clear(self): _t_clear()",
        "        def colormode(self, *a, **k): pass",
        "    _default = {}",
        "    def _get_default():",
        "        if 'turtle' not in _default:",
        "            _default['turtle'] = Turtle()",
        "        return _default['turtle']",
        "    def forward(d): _get_default().forward(d)",
        "    def fd(d): _get_default().forward(d)",
        "    def backward(d): _get_default().backward(d)",
        "    def bk(d): _get_default().backward(d)",
        "    def back(d): _get_default().backward(d)",
        "    def right(a): _get_default().right(a)",
        "    def rt(a): _get_default().right(a)",
        "    def left(a): _get_default().left(a)",
        "    def lt(a): _get_default().left(a)",
        "    def penup(): _get_default().penup()",
        "    def pu(): _get_default().penup()",
        "    def up(): _get_default().penup()",
        "    def pendown(): _get_default().pendown()",
        "    def pd(): _get_default().pendown()",
        "    def down(): _get_default().pendown()",
        "    def goto(x, y=None): _get_default().goto(x, y)",
        "    def setpos(x, y=None): _get_default().goto(x, y)",
        "    def setposition(x, y=None): _get_default().goto(x, y)",
        "    def setx(x): _get_default().setx(x)",
        "    def sety(y): _get_default().sety(y)",
        "    def setheading(a): _get_default().setheading(a)",
        "    def seth(a): _get_default().setheading(a)",
        "    def home(): _get_default().home()",
        "    def heading(): return _get_default().heading()",
        "    def position(): return _get_default().position()",
        "    def pos(): return _get_default().position()",
        "    def xcor(): return _get_default().xcor()",
        "    def ycor(): return _get_default().ycor()",
        "    def distance(x, y=None): return _get_default().distance(x, y)",
        "    def circle(r, extent=None, steps=None): _get_default().circle(r, extent, steps)",
        "    def dot(size=None, color=None): _get_default().dot(size, color)",
        "    def write(text, move=False, align='left', font=None): _get_default().write(text, move, align, font)",
        "    def color(c1=None, c2=None): _get_default().color(c1, c2)",
        "    def pencolor(c=None): return _get_default().pencolor(c)",
        "    def fillcolor(c=None): return _get_default().fillcolor(c)",
        "    def pensize(w=None): return _get_default().pensize(w)",
        "    def width(w=None): return _get_default().pensize(w)",
        "    def begin_fill(): _get_default().begin_fill()",
        "    def end_fill(): _get_default().end_fill()",
        "    def speed(s=None): pass",
        "    def hideturtle(): _get_default().hideturtle()",
        "    def ht(): _get_default().hideturtle()",
        "    def showturtle(): _get_default().showturtle()",
        "    def st(): _get_default().showturtle()",
        "    def isdown(): return _get_default().isdown()",
        "    def clear(): _t_clear()",
        "    def reset(): _get_default().reset()",
        "    def bgcolor(c=None):",
        "        if c is not None: _t_bgcolor(_pyslate_color(c))",
        "    def title(t): pass",
        "    def setup(*a, **k): pass",
        "    def screensize(*a, **k): pass",
        "    def tracer(*a, **k): pass",
        "    def update(): pass",
        "    def done(): pass",
        "    def mainloop(): pass",
        "    def bye(): pass",
        "    def exitonclick(): pass",
        "    def listen(): pass",
        "    def onkey(*a, **k): pass",
        "    def onclick(*a, **k): pass",
        "    def colormode(*a, **k): pass",
        "    mod = types.ModuleType('turtle')",
        "    for _name, _val in list(locals().items()):",
        "        if not _name.startswith('_'):",
        "            setattr(mod, _name, _val)",
        "    return mod",
        "sys.modules['turtle'] = _pyslate_build_turtle_module()",
        "def _pyslate_capture_figures():",
        "    if 'matplotlib.pyplot' not in sys.modules:",
        "        return []",
        "    import io, base64",
        "    plt = sys.modules['matplotlib.pyplot']",
        "    imgs = []",
        "    for num in plt.get_fignums():",
        "        fig = plt.figure(num)",
        "        buf = io.BytesIO()",
        "        fig.savefig(buf, format='png', bbox_inches='tight', facecolor='white')",
        "        imgs.append(base64.b64encode(buf.getvalue()).decode('ascii'))",
        "    plt.close('all')",
        "    return imgs"
      ].join("\n");

      pyodide.globals.set('_t_show', _turtleShow);
      pyodide.globals.set('_t_clear', _turtleClear);
      pyodide.globals.set('_t_line', _turtleLine);
      pyodide.globals.set('_t_dot', _turtleDot);
      pyodide.globals.set('_t_text', _turtleText);
      pyodide.globals.set('_t_polygon', _turtlePolygon);
      pyodide.globals.set('_t_bgcolor', _turtleBgcolor);

      await pyodide.runPythonAsync(setup);

      // Proactively install any imported packages that aren't already available
      // (numpy, pandas, matplotlib, sympy, requests, ... anything with a PyPI wheel).
      const neededFn = pyodide.globals.get('_pyslate_needed_installs');
      const neededProxy = neededFn(data.code);
      const needed = neededProxy.toJs ? neededProxy.toJs() : [];
      neededProxy.destroy(); neededFn.destroy();
      if(needed.length){
        try{
          await pyodide.loadPackage('micropip');
          const micropip = pyodide.pyimport('micropip');
          for(const pkg of needed){
            self.postMessage({type:'installing', packages:[pkg]});
            try{
              await micropip.install(pkg);
            }catch(installErr){
              self.postMessage({type:'install-failed', package: pkg});
            }
          }
        }catch(loadErr){
          self.postMessage({type:'install-failed', package: needed.join(', ')});
        }
      }
      // matplotlib needs a non-interactive backend before pyplot is imported by user code
      await pyodide.runPythonAsync("try:\n    import matplotlib\n    matplotlib.use('Agg')\nexcept Exception:\n    pass");

      const runFn = pyodide.globals.get('_pyslate_run');
      let ok;
      try{
        ok = runFn(data.code);
      } finally {
        runFn.destroy();
      }

      const capFn = pyodide.globals.get('_pyslate_capture_figures');
      const imgsProxy = capFn();
      const imgs = imgsProxy.toJs ? imgsProxy.toJs() : [];
      imgsProxy.destroy(); capFn.destroy();
      for(const b64 of imgs){ self.postMessage({type:'image', data: b64}); }

      self.postMessage(ok ? {type:'done'} : {type:'run-error'});
    }catch(err){
      self.postMessage({type:'error', message: (err && err.message) ? err.message : String(err)});
    }
  }
};
