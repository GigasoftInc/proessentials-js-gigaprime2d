// ProEssentialsJS -- Copyright 1994-2026 Gigasoft, Inc. All rights reserved.
// Commercial product, free for commercial use under USD 250,000 annual
// revenue. See PEJS-LICENSE.md -- https://www.gigasoft.com

// GigaPrime2D for JavaScript -- five live signals on five stacked Y axes,
// re-passed and redrawn every frame from the same C++ engine the desktop
// control uses.  The browser port of GigaPrime2DwinUI\MainWindow.xaml.cs.
//
// Differences from the desktop version:
//
//   Points per signal is selectable rather than fixed at 20,000,000.  The
//   desktop holds ~1 GB of live float32 before the engine allocates anything
//   and wasm32 cannot, so the size is a control and the FPS readout sits
//   beside it.
//
//   No licence keys.  The wasm engine is not licence-gated.
//
//   Window.Title is the #fps element, ContentDialog is the #help overlay and
//   DispatcherTimer is setTimeout.  Everything else -- the five axes, the
//   shared X array, the zero-copy Y buffer, the zoom slider, Combine, Hide,
//   Highlight and Legend -- is the same properties in the same order.

// Enums come from this control's own facade, which is C#'s
// using Gigasoft.ProEssentials.Enums.  They are renumbered per control, so
// naming the facade is what keeps a Pesgo page off a Pe3do value.
import {
  attachApi,
  AllowZooming, BitmapStyle, Composite2D3D, DataShadows, DuplicateData,
  FontSize, LegendStyle, LineType, ManualScaleControl, MenuControl,
  MouseWheelFunction, RenderEngine, ShowAxis, TABorder,
} from './lib/pe-api-sgraph.js';

const $ = (s) => document.querySelector(s);

// ---------------------------------------------------------------------------
// Scale.  SUBSETS is fixed; POINTS is per signal, so the total is 5x.
// SLACK is the pool tail the per-tick random offset slides through.  The
// desktop uses 1.2x the chart buffer; the waveforms repeat every WAVE samples,
// so one period gives the same picture for a fraction of the memory.
// ---------------------------------------------------------------------------
const SUBSETS = 5;
const WAVE = 10000;             // wavedata[10000] in the C#
const SLACK = WAVE;             // pool tail == one waveform period

const POINT_CHOICES = [
  { n:  20000, label:    '20,000  x5 =   100,000' },
  { n:  40000, label:    '40,000  x5 =   200,000' },
  { n:  80000, label:    '80,000  x5 =   400,000  (default)' },
  { n: 200000, label:   '200,000  x5 = 1,000,000' },
  { n: 400000, label:   '400,000  x5 = 2,000,000' },
  { n: 1000000, label: '1,000,000  x5 = 5,000,000' },
  // Stress sizes.  At ~17.6 ns per point these are seconds per frame, so the
  // timer becomes a slideshow; they test that the allocation and the engine
  // survive the size.  See allocFailed() for what happens when they do not.
  { n:  5000000, label:  '5,000,000  x5 =  25,000,000  (stress)', stress: true },
  { n: 10000000, label: '10,000,000  x5 =  50,000,000  (stress)', stress: true },
  // The desktop demo's own size, 5 x 20,000,000 re-passed per tick.
  { n: 20000000, label: '20,000,000  x5 = 100,000,000  (Win32 parity)', stress: true },
];
const DEFAULT_POINTS = 80000;

// Live float32 the page asks for at a given scale, in MB: the Y buffer and the
// X array, both in the WASM HEAP. THERE IS NO POOL -- see fillFromPool.
const memMB = (n) => Math.round(((n * SUBSETS * 4) + (n * 4)) / 1048576);

// ---------------------------------------------------------------------------
// Colours. PERGB is 0xAABBGGRR -- r | g<<8 | b<<16 | a<<24 (COLORCTL.CPP:20),
// NOT ARGB. The XAML writes Color.FromArgb(255, 255, 0, 69) and the hex in the
// panel CSS is #FF0045; both are the same colour said two ways.
// ---------------------------------------------------------------------------
const PERGB = (a, r, g, b) => ((r | (g << 8) | (b << 16) | (a << 24)) >>> 0);

// ---------------------------------------------------------------------------
// A fixed sequence rather than Math.random(), so two loads of the same
// settings draw the same chart and can be compared.  Same shape and range as
// Random.NextDouble(), reset before each rebuild.
// ---------------------------------------------------------------------------
let seed = 12345;
const RandNum = {
  reset(s) { seed = (s === undefined ? 12345 : s) >>> 0; },
  nextDouble() {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  },
};

const SUBSET_COLORS = [
  PERGB(255, 255,   0,  69),
  PERGB(255,  63, 255,   0),
  PERGB(255, 255, 168,   0),
  PERGB(255, 255,  20, 255),
  PERGB(255,  26, 255, 255),
];
const SUBSET_SHADES = [
  PERGB(255,  80,  80,  80),
  PERGB(255, 100, 100, 100),
  PERGB(255,  60,  60,  60),
  PERGB(255, 120, 120, 120),
  PERGB(255,  50,  50,  50),
];

// ---------------------------------------------------------------------------
// Module state. The C# holds these as MainWindow statics.
// ---------------------------------------------------------------------------
let m = null;            // the emscripten module
let ctl = null;          // PeControl
/** @type {import('./lib/pe-api-sgraph.js').PeChart} */
let Pesgo1 = null;       // the chart facade, attached to the handle
let chartReady = false;  // WinUI's _chartReady, replacing the Chart==null guard

let POINTS = DEFAULT_POINTS;

let xBlock = null;       // fXData        -- wasm heap, shared by all subsets
let yBlock = null;       // fYDataToChart -- wasm heap, the pointer the engine keeps
let waves = null;        // the five 10,000-sample waveforms
let phases = null;       // each signal's fixed starting offset into its waveform

let timer = null;        // DispatcherTimer
let frameCount = 0;
let lastFpsTime = 0;
let lastFps = 0;
let updatingSlider = false;

// Property ids the engine refused, for the status line.
const rejectedIds = () => (ctl && ctl.rejectedIds) || [];

// ===========================================================================
// DATA
// ===========================================================================

// The five waveforms, verbatim from MainWindow.xaml.cs:70-74.
function makeWaves() {
  const w = [];
  for (let s = 0; s < SUBSETS; s++) w.push(new Float32Array(WAVE));
  for (let j = 0; j <= WAVE - 1; j++) {
    w[0][j] = (Math.sin(3.1415 * 0.0002 * j) * 10.0) + 10.0;
    w[1][j] = (Math.sin(3.1415 * 0.0001 * j) * 20.0);
    w[2][j] = (Math.sin(3.1415 * 0.0006 * j) * 10.0) + 10.0;
    w[3][j] = (Math.sin(3.1415 * 0.00005 * j) * 20.0);
    w[4][j] = (Math.sin(2.5415 * 0.0004 * j) * Math.sin(3.1415 * 0.0001 * j) * 10.0) + 10.0;
  }
  return w;
}

// There is no staging pool.  The desktop tiles the waveforms into a
// 120,010,000-float buffer and copies slices of it each tick; the waveforms
// repeat every WAVE samples, so tiling straight from the 10,000-sample source
// draws the identical picture and halves the footprint.
function buildWaves() {
  waves = makeWaves();
  RandNum.reset();
  // The C#'s per-signal nShift, from the fixed sequence so a reload repeats.
  phases = [0];
  for (let s = 1; s < SUBSETS; s++)
    phases.push(Math.trunc(RandNum.nextDouble() * (WAVE - 1)));
}

// Allocate the arrays and hand the engine the two addresses.  The blocks must
// outlive this call: the engine keeps the address, not the values, so they are
// freed only in releaseBlocks() on a point-count change.
function allocAndPoint() {
  xBlock = Pesgo1.PeData.X.allocate(POINTS);
  yBlock = Pesgo1.PeData.Y.allocate(POINTS * SUBSETS);

  // --- Prepare X data --- (fXData[j] = j + 1)
  const xa = xBlock.array;
  for (let j = 0; j < POINTS; j++) xa[j] = j + 1;

  // Share X data across all subsets -- avoids duplicating POINTS x data points
  Pesgo1.PeData.DuplicateDataX = DuplicateData.PointIncrement;

  // Pass pointers to data arrays -- no copy, chart uses app memory directly
  Pesgo1.PeData.X.useDataAtLocation(xBlock, POINTS);
  Pesgo1.PeData.Y.useDataAtLocation(yBlock, POINTS * SUBSETS);
}

function releaseBlocks() {
  // Release the pointer BEFORE free(), or the engine holds an address the
  // allocator has already handed to something else.
  if (Pesgo1) {
    Pesgo1.PeData.X.useDataAtLocation();
    Pesgo1.PeData.Y.useDataAtLocation();
  }
  if (xBlock) { xBlock.free(); xBlock = null; }
  if (yBlock) { yBlock.free(); yBlock = null; }
}

// ===========================================================================
// THE CHART -- Pesgo1_Loaded, transcribed
// ===========================================================================
function buildChart() {
  // --- Initialize ProEssentials PesgoWinUI ---
  Pesgo1.PeFont.SizeGlobalCntl = 1.05;

  // C#: Api.PEvsetW(HObject, 1798, keys, 16) -- the licence keys. No
  // array-of-int export exists on the flat boundary and the wasm engine is not
  // licence-gated, so there is nothing to write here.

  Pesgo1.PeData.Subsets = SUBSETS;
  Pesgo1.PeData.Points = POINTS;

  // Define 5 axes, 1 subset per axis
  for (let i = 0; i < SUBSETS; i++) Pesgo1.PeGrid.MultiAxesSubsets[i] = 1;

  // X axis
  Pesgo1.PeGrid.Configure.ManualScaleControlX = ManualScaleControl.MinMax;
  Pesgo1.PeGrid.Configure.ManualMinX = 0;
  Pesgo1.PeGrid.Configure.ManualMaxX = POINTS;
  Pesgo1.PeString.XAxisLabel = 'Sample';

  // Y axis per WorkingAxis. The units alternate exactly as the C# does --
  // uV, uV, mV, mV, uV.
  const UNITS = ['uV', 'uV', 'mV', 'mV', 'uV'];
  for (let i = 0; i < SUBSETS; i++) {
    Pesgo1.PeGrid.WorkingAxis = i;
    Pesgo1.PeGrid.Configure.ManualScaleControlY = ManualScaleControl.MinMax;
    Pesgo1.PeGrid.Configure.ManualMinY = 0;
    Pesgo1.PeGrid.Configure.ManualMaxY = 21;
    Pesgo1.PeString.YAxisLabel = UNITS[i];
  }
  Pesgo1.PeGrid.WorkingAxis = 0; // always reset WorkingAxis when done

  // Reset default data points
  Pesgo1.PeData.Y[0][0] = 0; Pesgo1.PeData.Y[0][1] = 0;
  Pesgo1.PeData.Y[0][2] = 0; Pesgo1.PeData.Y[0][3] = 0;
  Pesgo1.PeData.X[0][0] = 1.0; Pesgo1.PeData.X[0][1] = 2.0;
  Pesgo1.PeData.X[0][2] = 3.0; Pesgo1.PeData.X[0][3] = 4.0;

  Pesgo1.PeData.NullDataValue = -9999999;
  Pesgo1.PeData.NullDataValueX = -9999999;

  Pesgo1.PeString.MainTitle = '';
  Pesgo1.PeString.SubTitle = '';

  // Disable built-in UI elements managed by our custom controls
  Pesgo1.PeUserInterface.Allow.FocalRect = false;
  Pesgo1.PeUserInterface.Dialog.PlotCustomization = false;
  Pesgo1.PeUserInterface.Dialog.Page2 = true;
  Pesgo1.PeUserInterface.Dialog.Axis = false;
  Pesgo1.PeUserInterface.Dialog.Subsets = false;
  Pesgo1.PeUserInterface.Dialog.RandomPointsToExport = false;
  Pesgo1.PeUserInterface.Allow.Customization = false;
  Pesgo1.PeUserInterface.Allow.Maximization = false;
  Pesgo1.PeUserInterface.Allow.Popup = true;
  Pesgo1.PeUserInterface.Menu.BorderType = MenuControl.Hide;
  Pesgo1.PeUserInterface.Menu.BitmapGradient = MenuControl.Hide;
  Pesgo1.PeUserInterface.Menu.QuickStyle = MenuControl.Hide;
  Pesgo1.PeUserInterface.Menu.ViewingStyle = MenuControl.Hide;
  Pesgo1.PeUserInterface.Menu.ShowLegend = MenuControl.Hide;
  Pesgo1.PeUserInterface.Menu.PlotMethod = MenuControl.Hide;
  Pesgo1.PeUserInterface.Menu.MarkDataPoints = MenuControl.Hide;
  Pesgo1.PeUserInterface.Menu.CustomizeDialog = MenuControl.Hide;
  Pesgo1.PeUserInterface.Menu.DataShadow = MenuControl.Hide;
  Pesgo1.PeUserInterface.Menu.DataPrecision = MenuControl.Hide;
  Pesgo1.PeUserInterface.Menu.LegendLocation = MenuControl.Hide;
  Pesgo1.PeUserInterface.Menu.ShowAnnotations = MenuControl.Hide;
  Pesgo1.PeUserInterface.Menu.AnnotationControl = false;
  Pesgo1.PeUserInterface.Dialog.AllowEmfExport = false;
  Pesgo1.PeUserInterface.Dialog.AllowSvgExport = false;
  Pesgo1.PeUserInterface.Dialog.AllowWmfExport = false;
  Pesgo1.PeUserInterface.Allow.TextExport = false;
  Pesgo1.PeUserInterface.Dialog.HideExportImageDpi = true;
  Pesgo1.PeUserInterface.Dialog.HidePrintDpi = true;

  // Zoom and scrollbar settings
  Pesgo1.PeUserInterface.Scrollbar.ScrollingHorzZoom = true;
  Pesgo1.PeUserInterface.Scrollbar.MouseWheelFunction = MouseWheelFunction.HorizontalZoom;
  Pesgo1.PeUserInterface.Scrollbar.MouseWheelZoomFactor = 1.05;
  Pesgo1.PeUserInterface.Scrollbar.MouseWheelZoomEvents = true;
  Pesgo1.PeUserInterface.Allow.Zooming = AllowZooming.None;

  // Subset labels
  for (let i = 0; i < SUBSETS; i++)
    Pesgo1.PeString.SubsetLabels[i] = 'Signal ' + (i + 1);

  // Subset colors -- matching WinForms version
  for (let i = 0; i < SUBSETS; i++) {
    Pesgo1.PeColor.SubsetColors[i] = SUBSET_COLORS[i];
    Pesgo1.PeColor.SubsetShades[i] = SUBSET_SHADES[i];
  }

  Pesgo1.PePlot.DataShadows = DataShadows.None;
  for (let i = 0; i < SUBSETS; i++)
    Pesgo1.PePlot.SubsetLineTypes[i] = LineType.ThinSolid;

  Pesgo1.PeSpecial.DpiX = 600;
  Pesgo1.PeSpecial.DpiY = 600;

  Pesgo1.PeUserInterface.Cursor.HourGlassThreshold = 2000000000;
  Pesgo1.PeFont.FontSize = FontSize.Large;
  Pesgo1.PeFont.Fixed = true;
  Pesgo1.PeLegend.Show = false;

  Pesgo1.PeConfigure.ImageAdjustTop = 100;
  Pesgo1.PeConfigure.ImageAdjustLeft = 100;

  Pesgo1.PeSpecial.AutoImageReset = false; // important for D3D, call Reinitialize explicitly

  // Required for the GPU path: the composite marker is what lets the player
  // reach the pass the WebGPU surface is drawn into.
  Pesgo1.PeConfigure.Composite2D3D = Composite2D3D.Background;

  // Color theme -- dark teal matching WinForms version
  Pesgo1.PeColor.BitmapGradientMode = false;
  Pesgo1.PeConfigure.BorderTypes = TABorder.NoBorder;
  Pesgo1.PeColor.GraphBmpStyle = BitmapStyle.NoBmp;
  Pesgo1.PeColor.GraphBackground = PERGB(0xff, 0x00, 0x2B, 0x35);
  Pesgo1.PeColor.Desk = PERGB(0xff, 0x00, 0x2B, 0x35);
  Pesgo1.PeColor.GraphForeground = PERGB(255, 255, 255, 255);
  Pesgo1.PeColor.Text = PERGB(255, 255, 255, 255);
  Pesgo1.PeGrid.GridBands = false;
  Pesgo1.PeColor.GridBold = false;

  Pesgo1.PeConfigure.CacheBmp = true;
  Pesgo1.PeConfigure.PrepareImages = true;

  // v11 GPU compute shader settings.  The control falls back to Direct2D on
  // its own if the browser gives it no device.
  Pesgo1.PeConfigure.RenderEngine = RenderEngine.Direct3D;
  Pesgo1.PeData.ComputeShader  = true;   // GPU-side chart construction
  Pesgo1.PeData.Filter2D3D     = true;   // only with ComputeShader + Line
  Pesgo1.PeData.StagingBufferY = true;   // always set for ComputeShader
  Pesgo1.PeData.StagingBufferX = true;

  // Set axis Y colors to match subset colors
  for (let i = 0; i < SUBSETS; i++) {
    Pesgo1.PeGrid.WorkingAxis = i;
    Pesgo1.PeColor.YAxis = SUBSET_COLORS[i];
  }
  Pesgo1.PeGrid.WorkingAxis = 0;

  allocAndPoint();
  fillFromPool(0);              // pinned: the boot picture is reproducible

  // Final render
  Pesgo1.PeFunction.Force3dxNewColors = true;
  Pesgo1.PeFunction.Force3dxVerticeRebuild = true;
  Pesgo1.PeFunction.ReinitializeResetImage();   // the C#'s own last line

  chartReady = true;

  // Initialize zoom slider
  sampleViewToZoomAmount(175);
}

// ===========================================================================
// Timer tick -- re-passes every point from pool to chart buffer
// ===========================================================================

// The Array.Copy block.  TypedArray.set is the memcpy; a per-element loop
// would dominate the frame.  `at` pins the offset so a fresh load always draws
// the same chart; the timer passes nothing and gets the animated sequence.
function fillFromPool(at) {
  const iRandomOffset = at !== undefined ? at
                      : Math.trunc(RandNum.nextDouble() * SLACK);
  const ya = yBlock.array;      // re-taken every tick: a stored view DETACHES
  for (let s = 0; s < SUBSETS; s++) {
    const src = waves[s];
    // Where in the repeating waveform this signal starts on this frame.
    const start = (phases[s] + iRandomOffset) % WAVE;
    let dst = s * POINTS, left = POINTS;
    // The partial first tile, then whole tiles, then the partial last one.
    // Every one is a TypedArray.set, i.e. a memcpy -- the loop only picks
    // lengths, it never touches an element.
    let take = Math.min(WAVE - start, left);
    ya.set(src.subarray(start, start + take), dst);
    dst += take; left -= take;
    while (left > 0) {
      take = Math.min(WAVE, left);
      ya.set(take === WAVE ? src : src.subarray(0, take), dst);
      dst += take; left -= take;
    }
  }
  // With UseDataAtLocation nothing passes through the API when the values
  // change, so no setter can mark the vertex buffer stale.  We own the memory,
  // so we raise the dirty signal.
  if (ctl) ctl.dataChanged();
}

function timerTick() {
  // FPS counter -- the C# writes this.Title; there is no title bar here.
  frameCount++;
  const now = performance.now();
  const elapsed = (now - lastFpsTime) / 1000;
  if (elapsed >= 1.0) {
    lastFps = frameCount / elapsed;
    // A background tab clamps setTimeout to one second, so the readout says
    // so rather than reporting 1.0 FPS as if it were the chart's speed.
    const hidden = document.visibilityState === 'hidden';
    $('#fps').textContent = hidden
      ? lastFps.toFixed(1) + ' FPS (tab hidden -- browser is clamping the timer)'
      : lastFps.toFixed(1) + ' FPS';
    frameCount = 0;
    lastFpsTime = now;
  }

  fillFromPool();

  // Invalidate composites the GPU layer and replays the stream already built;
  // it never rebuilds it.  That is right here only because the axes do not
  // move when the Y values change.  The zoom slider is the opposite case.
  Pesgo1.PeData.ReuseDataX = true;                 // X unchanged, reuse buffer
  Pesgo1.PeFunction.Force3dxVerticeRebuild = true; // process new Y data
  Pesgo1.Invalidate();

  // The C# restarts a 15 ms DispatcherTimer; setTimeout(0) after the work
  // yields and runs again as soon as it can, so the FPS number is the chart's
  // ceiling rather than a timer interval read back.
  if (timer !== null) timer = setTimeout(timerTick, 0);
}

function startTimer() {
  if (timer !== null) return;
  frameCount = 0;
  lastFpsTime = performance.now();
  timer = setTimeout(timerTick, 0);
}

function stopTimer() {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  $('#fps').textContent = '';
}

// ===========================================================================
// Zoom slider
// ===========================================================================
function sampleViewToZoomAmount(nSliderValue) {
  const dValue = nSliderValue / 1000.0;
  const dZoomRange = POINTS * dValue;
  const dHalfRange = dZoomRange / 2.0;
  const mid = POINTS / 2.0;

  // Clamp to the data extent. X data is 1..POINTS, so an unclamped window at
  // full slider starts at 0, which is outside the data and is also the null
  // data value.
  let lo = mid - dHalfRange;
  let hi = mid + dHalfRange;
  if (lo < 1) lo = 1;
  if (hi > POINTS) hi = POINTS;

  Pesgo1.PeGrid.Zoom.MinX = lo;
  Pesgo1.PeGrid.Zoom.MaxX = hi;

  for (let i = 0; i < SUBSETS; i++) {
    Pesgo1.PeGrid.WorkingAxis = i;
    Pesgo1.PeGrid.Zoom.MinY = Pesgo1.PeGrid.Configure.ManualMinY;
    Pesgo1.PeGrid.Zoom.MaxY = Pesgo1.PeGrid.Configure.ManualMaxY;
  }
  Pesgo1.PeGrid.WorkingAxis = 0;
  Pesgo1.PeGrid.Zoom.Mode = true;
}

function onSlider() {
  if (!chartReady || updatingSlider) return;
  sampleViewToZoomAmount(Number($('#sliderSampleView').value));
  Pesgo1.PeGrid.Zoom.Mode = true;
  // The C# is Reinitialize() then Invalidate().  On the web Invalidate never
  // rebuilds the image, and the slider moves the range, so the axes and tick
  // labels have to be rebuilt -- which is what ReinitializeResetImage does.
  Pesgo1.PeFunction.ReinitializeResetImage();
}

// Zoom events -- sync slider with chart zoom state (Pesgo1_PeZoomIn/Out).
function onZoomIn() {
  if (Pesgo1.PeGrid.Zoom.Mode) {
    const dZoom = Pesgo1.PeGrid.Zoom.MaxX - Pesgo1.PeGrid.Zoom.MinX;
    const dZoomPercent = (dZoom / POINTS) * 100;
    let nNewValue = Math.trunc(dZoomPercent) * 10;
    if (nNewValue < 1) nNewValue = 1;
    if (nNewValue > 1000) nNewValue = 1000;
    updatingSlider = true;
    $('#sliderSampleView').value = nNewValue;
    updatingSlider = false;
  } else {
    updatingSlider = true;
    $('#sliderSampleView').value = 1000;
    updatingSlider = false;
  }
}

function onZoomOut() {
  updatingSlider = true;
  $('#sliderSampleView').value = 1000;
  updatingSlider = false;
}

// ===========================================================================
// Combine / Hide / Legend / Highlight
// ===========================================================================
function onCombineAxes() {
  if (!chartReady) return;
  const on = $('#combineAxes').checked;
  if (on) {
    Pesgo1.PeGrid.OverlapMultiAxes[0] = SUBSETS;
    setHideEnabled(true);
    for (let i = 1; i <= SUBSETS; i++) $('#highlightAxis' + i).checked = false;
    Pesgo1.PeGrid.MultiAxesProportions.clear();
    if ($('#hideAxes').checked) hide4Axes(); else show4Axes();
  } else {
    Pesgo1.PeGrid.OverlapMultiAxes.clear();
    setHideEnabled(false);
    show4Axes();
  }
  Pesgo1.PeFunction.ReinitializeResetImage();
}

function onHideAxes() {
  if (!chartReady) return;
  if ($('#hideAxes').checked) hide4Axes(); else show4Axes();
  Pesgo1.PeFunction.ReinitializeResetImage();
}

function hide4Axes() {
  for (let i = 1; i < SUBSETS; i++) {
    Pesgo1.PeGrid.WorkingAxis = i;
    Pesgo1.PeGrid.Option.ShowYAxis = ShowAxis.Empty;
  }
  Pesgo1.PeGrid.WorkingAxis = 0;
  Pesgo1.PeString.YAxisLabel = 'Combined Axes';
}

function show4Axes() {
  for (let i = 1; i < SUBSETS; i++) {
    Pesgo1.PeGrid.WorkingAxis = i;
    Pesgo1.PeGrid.Option.ShowYAxis = ShowAxis.All;
  }
  Pesgo1.PeGrid.WorkingAxis = 0;
  Pesgo1.PeString.YAxisLabel = 'uV';
}

function onShowLegend() {
  if (!chartReady) return;
  if ($('#showLegend').checked) {
    Pesgo1.PeLegend.Show = true;
    Pesgo1.PeLegend.Style = LegendStyle.OneLineTopOfAxis;
  } else {
    Pesgo1.PeLegend.Show = false;
    Pesgo1.PeLegend.Style = LegendStyle.TwoLine;
  }
  Pesgo1.PeLegend.SimpleLine = true;
  Pesgo1.PeFunction.ReinitializeResetImage();
}

function onHighlight(axis) {
  if (!chartReady) return;
  const box = $('#highlightAxis' + (axis + 1));
  if (box.checked) {
    for (let i = 0; i < SUBSETS; i++)
      if (i !== axis) $('#highlightAxis' + (i + 1)).checked = false;
    for (let i = 0; i < SUBSETS; i++)
      Pesgo1.PeGrid.MultiAxesProportions[i] = (i === axis) ? 0.80 : 0.05;
  } else {
    Pesgo1.PeGrid.MultiAxesProportions.clear();
  }
  Pesgo1.PeFunction.ReinitializeResetImage();
}

function setHideEnabled(on) {
  $('#hideAxes').disabled = !on;
  $('#hideAxesLbl').classList.toggle('off', !on);
  if (!on) $('#hideAxes').checked = false;
}

// ===========================================================================
// Point count -- rebuild everything at the new scale
// ===========================================================================
function setStatus(s, cls) {
  const el = $('#status');
  el.textContent = s;
  el.className = cls || '';
}

// Rebuild from scratch rather than patch.  Patching Points and ManualMaxX in
// place would leave the zoom range, the axis bands and the pointer lengths
// describing the old scale.
function rebuildAt(n) {
  releaseBlocks();
  POINTS = n;
  buildWaves();
  Pesgo1.PeFunction.Reset();
  buildChart();         // allocate() throws if the WASM heap will not grow
  fitPane();
  $('#total').textContent = totalLabel();
}

async function onPointCount() {
  const sel = $('#pointCount');
  const n = Number(sel.value);
  if (n === POINTS) return;
  const previous = POINTS;
  const wasRunning = timer !== null;
  stopTimer();
  chartReady = false;

  // A large size can fail to allocate, and the browser says no by throwing
  // mid-rebuild with the blocks already released.  Falling back to the
  // previous size keeps that from leaving a dead page.  The await yields once
  // so the message is painted before the synchronous rebuild starts.
  setStatus(`building ${(n * SUBSETS).toLocaleString()} points`
            + ` (~${memMB(n)} MB) -- the page will not respond while it does`);
  await new Promise((r) => setTimeout(r, 0));

  try {
    rebuildAt(n);
  } catch (e) {
    const msg = `${(n * SUBSETS).toLocaleString()} points (~${memMB(n)} MB)`
              + ` FAILED: ${e && e.message ? e.message : e}`
              + ` -- fell back to ${(previous * SUBSETS).toLocaleString()}`;
    sel.value = String(previous);
    try {
      rebuildAt(previous);
    } catch (e2) {
      setStatus('rebuild failed at both sizes; reload the page', 'bad');
      return;
    }
    chartReady = true;
    Pesgo1.Invalidate();   // repaint what is there; the rebuild already ran
    // LAST, deliberately: ctl.onRender writes the status line on every render,
    // so a message set before the fallback redraw is overwritten by it and the
    // failure reports itself as a normal frame.
    setStatus(msg, 'bad');
    return;                     // do NOT restart the timer into a failed state
  }

  reportRejects();
  if (wasRunning) startTimer();
}

const totalLabel = () =>
  `${SUBSETS} signals x ${POINTS.toLocaleString()} = ` +
  `${(SUBSETS * POINTS).toLocaleString()} points`;

// Any property the engine refused, on the status line.
function reportRejects() {
  const el = $('#diag');
  const bits = [];
  const refused = rejectedIds();
  if (refused.length)
    bits.push('<span class="bad">refused: ' + [...new Set(refused)].join(', ')
            + '</span>');
  el.innerHTML = bits.length ? bits.join('   ') : 'no property refused';
}

// ===========================================================================
// Layout
// ===========================================================================
//
// fitInto subtracts the control's own scrollbar chrome from the box it is
// given, and a chart grows that chrome only when it draws -- so the first fit
// comes out one scrollbar too wide.  Re-measure until the number stops moving.
function fitPane() {
  if (!ctl) return;
  const pane = $('#chartpane');
  const cs = getComputedStyle(pane);
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  let last = -1;
  for (let i = 0; i < 3; i++) {
    const w = pane.clientWidth - padX - 2;   // -2 for the canvas border
    const h = pane.clientHeight - padY - 2;
    if (w <= 0 || h <= 0) return;
    ctl.fitInto(w, h);
    if (ctl.width === last) break;
    last = ctl.width;
  }
  // Keeping the WebGPU surface in step with the chart size was page plumbing
  // and is gone: the control sizes its own canvas in _gpuSync / _gpuSetSize.
}

// ===========================================================================
// Boot
// ===========================================================================
function wireUi() {
  // The stress sizes are not offered on a phone: 100,000,000 points is ~458 MB
  // and the OS kills the tab without raising a JS exception first, so prevent
  // the allocation rather than catch it.  Keyed off the short side of the
  // screen, which does not change when the phone turns, and off touch, so a
  // small desktop window keeps the full range.
  const shortSide = Math.min(window.screen.width, window.screen.height);
  const isPhone = navigator.maxTouchPoints > 0 && shortSide <= 500;
  const sel = $('#pointCount');
  for (const c of POINT_CHOICES) {
    if (isPhone && c.stress) continue;
    const o = document.createElement('option');
    o.value = String(c.n);
    o.textContent = `${c.label}  ~${memMB(c.n)} MB`;
    if (c.n === DEFAULT_POINTS) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener('change', onPointCount);

  $('#timerControl').addEventListener('change', (e) => {
    if (e.target.checked) startTimer(); else stopTimer();
  });
  $('#combineAxes').addEventListener('change', () => { onCombineAxes(); reportRejects(); });
  $('#hideAxes').addEventListener('change', onHideAxes);
  $('#showLegend').addEventListener('change', onShowLegend);
  $('#sliderSampleView').addEventListener('input', onSlider);
  for (let i = 0; i < SUBSETS; i++)
    $('#highlightAxis' + (i + 1)).addEventListener('change', () => onHighlight(i));

  // Help -- the ContentDialog's text.  The phone list is shorter because the
  // phone layout does not show Highlight Signal or Combine Axes, and there is
  // no right-click.
  const HELP_INTRO =
    'This demo shows ProEssentials rendering a full multi-signal data set ' +
    'completely re-passed and redrawn on every frame, in the browser, from ' +
    'the same C++ engine the desktop control uses.\n\n' +
    'The header displays live FPS.\n\n' +
    'Controls:\n';
  const HELP_PHONE =
    '1. Pinch or drag -- zooms and pans the X axis range.\n' +
    '2. Zoom X Axes slider -- programmatic zoom control.\n' +
    '3. Points per signal -- rebuilds the chart at a new scale.\n' +
    '4. Start/Stop Timer -- runs the live re-pass loop.';
  const HELP_DESKTOP =
    '1. Mouse Wheel -- zooms X axis range.\n' +
    '2. Right-click -- shows popup menu.\n' +
    '3. Right-click, Undo Zoom -- resets chart zoom.\n' +
    '4. Zoom X Axes slider -- programmatic zoom control.\n' +
    '5. Highlight Signal checkboxes -- expand individual axis to 80% height.\n' +
    '6. Combine Axes -- overlaps all 5 signals into one shared graph area.\n' +
    '7. Points per signal -- rebuilds the chart at a new scale.';

  // The license notice the visitor actually sees.  A header at the top of a
  // file reaches nobody who only runs the demo.  Anything past the summary is
  // a link, so this cannot drift apart from PEJS-LICENSE.md on anything that
  // matters.
  const HELP_LICENSE =
    '\n\n' +
    'ProEssentialsJS -- the ProEssentials charting engine compiled to ' +
    'WebAssembly, with a .NET-shaped JavaScript API.\n\n' +
    'Copyright 1994-2026 Gigasoft, Inc. All rights reserved.\n\n' +
    'A commercial product, and free for commercial use -- including ' +
    'redistribution -- by organizations under USD 250,000 annual gross ' +
    'revenue. No watermark, no feature gates, no expiry and no reduced ' +
    'feature set. No license key, no activation, no domain locking and no ' +
    'phone home: nothing here contacts Gigasoft at build time or at run ' +
    'time, and it collects no usage data.\n\n' +
    'Full terms: https://www.gigasoft.com/license\n' +
    'Summary that travels with this demo: PEJS-LICENSE.md\n\n' +
    'If you are using ProEssentialsJS in your study or work, please mention ' +
    'us on social media. It helps more than you would think.';

  // Which text is a layout question, so it follows the same media query that
  // hides the controls -- not isPhone above, which is the device and gates the
  // memory cap.  A listener keeps it in step across a window resize.
  const phoneLayout = window.matchMedia('(max-height: 480px), (max-width: 760px)');
  const writeHelp = () => {
    $('#helptext').textContent =
      HELP_INTRO + (phoneLayout.matches ? HELP_PHONE : HELP_DESKTOP) +
      HELP_LICENSE;
  };
  writeHelp();
  if (phoneLayout.addEventListener) phoneLayout.addEventListener('change', writeHelp);
  else if (phoneLayout.addListener) phoneLayout.addListener(writeHelp);   // older Safari

  // OK, a backdrop tap or Escape all close it, so a layout that pushes the
  // button off a short screen cannot trap the visitor in a modal.
  const helpOpen = (on) => $('#help').classList.toggle('on', on);
  $('#helpButton').addEventListener('click', () => helpOpen(true));
  $('#helpOk').addEventListener('click', () => helpOpen(false));
  // Only a tap on the backdrop itself, never one that bubbled out of the box.
  $('#help').addEventListener('click', (e) => {
    if (e.target === $('#help')) helpOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('#help').classList.contains('on')) helpOpen(false);
  });
}

// ===========================================================================
// Loading screen
// ===========================================================================
//
// The markup is in index.html and the CSS shows it, so it paints before any
// of this runs.  These functions only narrate it and then take it away; a
// loader created by script cannot cover the wait for that script.
function loadPhase(text) {
  const el = $('#loadPhase');
  if (el) el.textContent = text;
}

// frac null means the size is not known yet; the bar sweeps rather than
// sitting at 0%.
function loadProgress(frac) {
  const bar = $('#loadBar'), fill = $('#loadFill');
  if (!bar || !fill) return;
  if (frac === null || frac === undefined) { bar.classList.add('indet'); return; }
  bar.classList.remove('indet');
  fill.style.width = Math.max(0, Math.min(1, frac)) * 100 + '%';
}

function loadDone() {
  const el = $('#loading');
  if (!el || el.classList.contains('done')) return;
  el.classList.add('done');
  setTimeout(() => { el.style.display = 'none'; }, 300);
}

// Every early return in main() comes through here, so a failure says what
// broke instead of leaving the loader up.
function loadFail(msg) {
  loadPhase('Could not start the demo');
  loadProgress(0);
  const el = $('#loadErr');
  if (el) el.textContent = msg;
  const bar = $('#loadBar');
  if (bar) bar.classList.remove('indet');
}

// Give the browser one frame to paint.  A background tab never fires rAF, so
// the timeout is what resolves there.
const paintOnce = () => new Promise((r) => {
  let done = false;
  const go = () => { if (!done) { done = true; r(); } };
  requestAnimationFrame(() => setTimeout(go, 0));
  setTimeout(go, 60);
});

// Fetch the engine here rather than letting the glue do it, so the loading bar
// can show real bytes -- the module is ~4.2 MB and that is most of the wait on
// a real connection.  The bytes are handed over through locateFile; this
// build's glue ignores Module.wasmBinary and would download the file twice.
async function fetchEngineWithProgress(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(url + ' -> HTTP ' + res.status);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total) { loadProgress(null); return res.arrayBuffer(); }
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    loadProgress(got / total);
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out.buffer;
}

(async function main() {
  wireUi();
  const say = setStatus;   // one status writer, so a failure cannot be
                           // overwritten by a path that did not know about it

  // PAINT FIRST. Everything below is synchronous engine work from the
  // browser's point of view, and without this yield the loading screen would
  // be composed and never shown.
  await paintOnce();

  loadPhase('Loading engine');
  let blobUrl = null;
  try {
    const bytes = await fetchEngineWithProgress('lib/proessentials.wasm');
    blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/wasm' }));
  } catch (e) {
    blobUrl = null;                       // fall back to the glue's own fetch
  }

  loadPhase('Starting engine');
  loadProgress(null);
  await paintOnce();
  try {
    m = blobUrl
      ? await ProEssentials({ locateFile: (p) => (/\.wasm$/.test(p) ? blobUrl : p) })
      : await ProEssentials();
  } catch (e) {
    say('proessentials.js failed to load: ' + e, 'bad');
    loadFail('proessentials.js failed to load: ' + e);
    return;
  } finally {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
  }

  // The QuickStyle bitmaps. They cannot load inside the module -- LoadImage
  // returns 0 by design in wasm -- so the host holds them under the engine's
  // own resource ids. This chart sets GraphBmpStyle = NoBmp, so nothing here
  // depends on them; loaded anyway because the popup menu can turn one on.
  try { await PeControl.loadBuiltins('lib/bmps'); } catch (e) { /* backgrounds only */ }
  await PeControl.loadNotifyNames('lib/pewn-names.json');

  // The visitor's own language, for the popup menu and the built-in dialogs.
  // No tag: PeControl.culture() reads navigator.languages, which is what a
  // desktop control does with the OS culture -- it exposes no property for it
  // either.  The candidate walk maximizes the tag before matching, so zh-CN
  // finds the zh-Hans bundle rather than falling through to English, and
  // English is overlaid underneath every culture so an id a translation lacks
  // keeps its English label.  Before the control exists, because its menus are
  // built with these strings.
  await PeControl.loadStrings(m);

  // No gpuLayer option: passing one tells the control the page owns the GPU
  // path and stops it installing its own.  trackRejects names any property
  // the engine refuses, for the status line.
  ctl = new PeControl($('#chartpane'), {
    module: m, kind: 'sgraph', width: 900, height: 600, trackRejects: true,
  });
  if (!ctl.handle) {
    say('pe_create_sgraph returned 0', 'bad');
    loadFail('pe_create_sgraph returned 0');
    return;
  }

  // The chart object.  Pesgo1 is everything a C# developer would recognise;
  // ctl is the host control the XAML would have supplied.
  Pesgo1 = ctl.attach(attachApi);

  // Events, as the C# writes them:  Pesgo1.PeZoomIn += Pesgo1_PeZoomIn.
  // .add() is +=, and it is multicast.  The handles exist only because
  // index.html loads pe-events.js.
  if (!ctl.PeZoomIn || !ctl.PeZoomOut) {
    say('pe-events.js did not load -- the .NET event handles are absent', 'bad');
    loadFail('pe-events.js did not load');
    return;
  }
  ctl.PeZoomIn.add(onZoomIn);
  ctl.PeZoomOut.add(onZoomOut);

  loadPhase('Preparing data');
  await paintOnce();

  // Which renderer drew the plot.  The metafile size says it: a large stream
  // means the CPU put the plot in it, ~10-20 KB means the plot went to the GPU
  // layer and the stream carries only axes, grid and text.
  ctl.onRender = (n) => {
    const g = ctl.gpuStats;
    const who = n > 200000 ? 'CPU DREW THE PLOT -- stream too big for GPU'
              : g && g.fallback ? `CPU (fell back: ${g.why || 'no device'})`
              : g && g.ok ? `GPU${g.source ? ' ' + g.source : ''}`
              : g && g.why ? `no GPU: ${g.why}`
              : 'GPU pending';
    say(`${ctl.width}x${ctl.height}  ${n.toLocaleString()} bytes  ${who}`);
  };

  // The handler is wired before the build so the boot render fills the status
  // line; buildChart() ends with ReinitializeResetImage().
  buildWaves();
  buildChart();
  fitPane();

  $('#total').textContent = totalLabel();
  reportRejects();

  // The chart is on the canvas, so the loader goes.  No minimum display time.
  loadDone();

  if (typeof ResizeObserver !== 'undefined')
    new ResizeObserver(() => fitPane()).observe($('#chartpane'));

  // Read-only handle for the phone viewer in tools\ and for the console.
  window.GigaPrime = {
    get ctl() { return ctl; },
    get chart() { return Pesgo1; },
    get points() { return POINTS; },
    get total() { return SUBSETS * POINTS; },
    get fps() { return lastFps; },
    get running() { return timer !== null; },
    get rejected() { return rejectedIds().slice(); },
    start: startTimer,
    stop: stopTimer,
    // One real frame, synchronously: the re-pass as well as the render.
    frame() { fillFromPool(); Pesgo1.PeData.ReuseDataX = true;
              Pesgo1.PeFunction.Force3dxVerticeRebuild = true;
              return Pesgo1.Invalidate(); },
    setZoom(v) { $('#sliderSampleView').value = v; onSlider(); },
  };
})();
