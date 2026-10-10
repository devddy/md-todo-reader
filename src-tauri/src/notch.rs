// Notch panel (macOS): a small borderless window that drops down from the
// MacBook notch while the pointer is over it. The window is swizzled into a
// non-activating NSPanel so clicking a checkbox never steals focus from the
// app you are working in. A background thread ticks every POLL; each tick runs
// on the main thread (AppKit) and compares the pointer with the hot zone and
// the open panel. All geometry is in AppKit points (origin bottom-left).

use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, NSObjectProtocol};
use objc2::{msg_send, sel, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSAutoresizingMaskOptions, NSEvent, NSGlassEffectView, NSGlassEffectViewStyle, NSPanel,
    NSScreen, NSStatusWindowLevel, NSView, NSVisualEffectBlendingMode, NSVisualEffectMaterial,
    NSVisualEffectState, NSVisualEffectView, NSWindow, NSWindowCollectionBehavior,
    NSWindowOrderingMode, NSWindowStyleMask,
};
use objc2_foundation::{NSPoint, NSRect, NSSize};
use tauri_nspanel::WebviewWindowExt;

pub const LABEL: &str = "notch";

/// The panel only shows while hovered, so it can be roomy: this wide, but
/// never closer than SCREEN_MARGIN (total) to the screen edges.
const WIDTH: f64 = 600.0;
const SCREEN_MARGIN: f64 = 80.0;
const MIN_HEIGHT: f64 = 80.0;
/// Corner radius of the glass card (all four corners, like the Dock).
const RADIUS: f64 = 22.0;
/// The card floats this far below the menu bar / notch.
const GAP: f64 = 8.0;
/// Height cap as a share of the screen's visible height; beyond it the list scrolls.
const MAX_SHARE: f64 = 0.85;
const POLL: Duration = Duration::from_millis(80);
/// Slack around the open panel before the pointer counts as "outside".
const HIT_MARGIN: f64 = 12.0;
const LEAVE_DELAY: Duration = Duration::from_millis(300);
/// Hot zone on screens without a notch: a thin strip at the top center.
const FALLBACK_ZONE: NSSize = NSSize { width: 220.0, height: 8.0 };

#[derive(Default)]
struct Inner {
    open: bool,
    outside_since: Option<Instant>,
    height: Option<f64>, // content height reported by the webview
    pinned: bool,        // the add-input is focused or holds unsent text
}

#[derive(Debug, PartialEq)]
enum Step {
    Stay,
    Open,
    Close,
}

impl Inner {
    /// One poll: open on entering the hot zone, close after LEAVE_DELAY outside
    /// both the zone and the panel, never close while pinned.
    fn step(&mut self, in_zone: bool, in_panel: bool, now: Instant) -> Step {
        if !self.open {
            if !in_zone {
                return Step::Stay;
            }
            self.open = true;
            self.outside_since = None;
            return Step::Open;
        }
        if self.pinned || in_zone || in_panel {
            self.outside_since = None;
            return Step::Stay;
        }
        let since = *self.outside_since.get_or_insert(now);
        if now.duration_since(since) < LEAVE_DELAY {
            return Step::Stay;
        }
        self.open = false;
        self.outside_since = None;
        self.pinned = false;
        Step::Close
    }
}

#[derive(Default)]
pub struct NotchState(Mutex<Inner>);

/// Sent to the notch webview on every open/close.
/// the content should pad below so nothing hides behind the camera housing.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NotchEvent {
    open: bool,
    max_height: f64, // the webview caps its layout here, so its scroll area matches the window
}

struct Geometry {
    zone: NSRect,
    top: f64,       // screen top edge
    panel_top: f64, // card top: below the menu bar / notch, minus GAP
    center_x: f64,
    width: f64,
    max_height: f64,
}

impl Geometry {
    fn event(&self, open: bool) -> NotchEvent {
        NotchEvent { open, max_height: self.max_height }
    }
}

/// Creates the hidden notch window and starts the pointer poller.
pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    app.manage(NotchState::default());
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
        .title("MD Todo Notch")
        .inner_size(WIDTH, MIN_HEIGHT)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .accept_first_mouse(true)
        .focused(false)
        .visible(false)
        .build()?;

    window.to_panel()?;
    let ptr = window.ns_window()? as *const NSPanel;
    // SAFETY: setup runs on the main thread and the pointer is the window we just swizzled.
    let panel = unsafe { &*ptr };
    panel.setStyleMask(NSWindowStyleMask::Borderless | NSWindowStyleMask::NonactivatingPanel);
    // Above the menu bar (24), so the panel covers the strip around the notch.
    panel.setLevel(NSStatusWindowLevel);
    panel.setCollectionBehavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::Stationary
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::IgnoresCycle,
    );
    // Panels hide when their app deactivates; ours is almost never the active app.
    panel.setHidesOnDeactivate(false);
    panel.setBecomesKeyOnlyIfNeeded(true);
    panel.setFloatingPanel(true);
    install_glass(panel);

    let handle = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(POLL);
        let app = handle.clone();
        if handle.run_on_main_thread(move || tick(&app)).is_err() {
            break; // event loop is gone
        }
    });
    Ok(())
}

/// The webview reports its content's natural height (measured independently of
/// the window, so it can grow); the window, and with it the "inside" area for
/// auto-collapse, hugs that height up to the screen-based cap in `panel_rect`.
pub fn set_height(app: &AppHandle, height: f64) {
    let height = height.max(MIN_HEIGHT);
    let open = {
        let state = app.state::<NotchState>();
        let mut s = state.0.lock().unwrap();
        if s.height == Some(height) {
            return;
        }
        s.height = Some(height);
        s.open
    };
    if open {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let (Some(mtm), Some(window)) = (MainThreadMarker::new(), ns_window(&handle)) {
                if let Some(g) = geometry(mtm) {
                    window.setFrame_display(panel_rect(&g, height), true);
                }
            }
        });
    }
}

fn tick(app: &AppHandle) {
    let Some(mtm) = MainThreadMarker::new() else { return };
    let Some(g) = geometry(mtm) else { return };
    let Some(window) = ns_window(app) else { return };
    let p = NSEvent::mouseLocation();
    let state = app.state::<NotchState>();
    let mut s = state.0.lock().unwrap();
    let rect = panel_rect(&g, s.height.unwrap_or(MIN_HEIGHT));
    // Hit-test the window's real frame, not the rect we asked for: AppKit may
    // have placed or sized it differently, and the bottom (add row) must count.
    let frame = window.frame();
    let in_panel = contains(keep_open_rect(frame, g.top, HIT_MARGIN), p);

    match s.step(contains(g.zone, p), in_panel, Instant::now()) {
        Step::Stay => {}
        Step::Open => {
            window.setFrame_display(rect, true);
            window.orderFrontRegardless(); // shows without activating the app
            let _ = app.emit_to(LABEL, "notch-state", g.event(true));
        }
        Step::Close => {
            #[cfg(debug_assertions)]
            eprintln!(
                "[notch] close: cursor=({:.0},{:.0}) frame=(x {:.0}, y {:.0}..{:.0}, w {:.0}) wanted_h={:.0} zone_y={:.0}",
                p.x,
                p.y,
                frame.origin.x,
                frame.origin.y,
                frame.origin.y + frame.size.height,
                frame.size.width,
                rect.size.height,
                g.zone.origin.y,
            );
            // Ordering out a key panel hands typing back to the app in front.
            window.orderOut(None);
            let _ = app.emit_to(LABEL, "notch-state", g.event(false));
        }
    }
}

/// The add-input got focus (or unsent text): keep the panel open and make it
/// key so it receives typing. The panel stays non-activating, so the app in
/// front keeps its menu bar and gets the keyboard back on `false`.
pub fn set_pinned(app: &AppHandle, pinned: bool, key: bool) {
    {
        let state = app.state::<NotchState>();
        let mut s = state.0.lock().unwrap();
        if !s.open {
            return;
        }
        s.pinned = pinned;
        s.outside_since = None; // a fresh LEAVE_DELAY once unpinned
    }
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(window) = ns_window(&handle) else { return };
        if key && !window.isKeyWindow() {
            window.makeKeyWindow();
        } else if !key && window.isKeyWindow() {
            window.resignKeyWindow();
        }
    });
}

/// The whole panel is one glass surface, like the Dock: Liquid Glass
/// (`NSGlassEffectView`, Clear style, macOS 26+) when the class exists, else a vibrancy view
/// forced Active (so it doesn't go grey while the panel is non-key). It sits
/// behind the transparent webview; CSS backdrop-filter can't blur the desktop.
fn install_glass(window: &NSWindow) {
    let Some(mtm) = MainThreadMarker::new() else { return };
    let Some(content) = window.contentView() else { return };
    let frame = content.bounds(); // uniform RADIUS on all four corners
    let liquid = AnyClass::get(c"NSGlassEffectView").is_some();

    let view: Retained<NSView> = if liquid {
        let glass = NSGlassEffectView::initWithFrame(NSGlassEffectView::alloc(mtm), frame);
        glass.setStyle(NSGlassEffectViewStyle::Clear); // the see-through variant
        glass.setCornerRadius(RADIUS);
        Retained::into_super(glass)
    } else {
        let fx = NSVisualEffectView::initWithFrame(NSVisualEffectView::alloc(mtm), frame);
        // Popover: light, and follows light/dark like the page colors (HUD is always dark).
        fx.setMaterial(NSVisualEffectMaterial::Popover);
        fx.setBlendingMode(NSVisualEffectBlendingMode::BehindWindow);
        fx.setState(NSVisualEffectState::Active);
        fx.setWantsLayer(true);
        // SAFETY: plain CALayer property setters on the view's own backing layer.
        unsafe {
            let layer: Option<Retained<AnyObject>> = msg_send![&*fx, layer];
            if let Some(layer) = layer {
                let _: () = msg_send![&*layer, setCornerRadius: RADIUS];
                let _: () = msg_send![&*layer, setMasksToBounds: true];
            }
        }
        Retained::into_super(fx)
    };
    view.setAutoresizingMask(
        NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable,
    );
    content.addSubview_positioned_relativeTo(&view, NSWindowOrderingMode::Below, None);

    #[cfg(debug_assertions)]
    eprintln!(
        "[notch] glass: {}",
        if liquid { "NSGlassEffectView (Liquid Glass)" } else { "NSVisualEffectView (Popover)" }
    );
}

fn ns_window(app: &AppHandle) -> Option<&'static NSWindow> {
    let ptr = app.get_webview_window(LABEL)?.ns_window().ok()? as *const NSWindow;
    // SAFETY: the notch window lives for the whole app run and is never closed.
    unsafe { ptr.as_ref() }
}

/// The notched (built-in) screen if there is one, else the primary screen.
fn geometry(mtm: MainThreadMarker) -> Option<Geometry> {
    let screens = NSScreen::screens(mtm);
    let notched = screens.iter().find(|s| notch_inset(s) > 0.0);
    let screen = notched.or_else(|| screens.firstObject())?;
    let f = screen.frame();
    let top = f.origin.y + f.size.height;
    let center_x = f.origin.x + f.size.width / 2.0;
    let inset = notch_inset(&screen);

    let zone = if inset > 0.0 && responds(&screen, sel!(auxiliaryTopLeftArea)) {
        // The notch is whatever the two menu-bar areas beside it leave uncovered.
        let left = screen.auxiliaryTopLeftArea().size.width;
        let right = screen.auxiliaryTopRightArea().size.width;
        NSRect::new(
            NSPoint::new(f.origin.x + left, top - inset),
            NSSize::new(f.size.width - left - right, inset),
        )
    } else {
        NSRect::new(
            NSPoint::new(center_x - FALLBACK_ZONE.width / 2.0, top - FALLBACK_ZONE.height),
            FALLBACK_ZONE,
        )
    };
    let width = WIDTH.min(f.size.width - SCREEN_MARGIN).max(zone.size.width);
    let max_height = screen.visibleFrame().size.height * MAX_SHARE;
    // Menu bar height from the visible frame; the notch inset if the bar auto-hides.
    let visible = screen.visibleFrame();
    let bar = (top - (visible.origin.y + visible.size.height)).max(inset);
    let panel_top = top - bar - GAP;
    Some(Geometry { zone, top, panel_top, center_x, width, max_height })
}

fn notch_inset(screen: &NSScreen) -> f64 {
    if responds(screen, sel!(safeAreaInsets)) {
        screen.safeAreaInsets().top
    } else {
        0.0 // before macOS 12
    }
}

fn responds(screen: &NSScreen, sel: objc2::runtime::Sel) -> bool {
    screen.respondsToSelector(sel)
}

fn panel_rect(g: &Geometry, height: f64) -> NSRect {
    let height = height.clamp(MIN_HEIGHT, g.max_height.max(MIN_HEIGHT));
    NSRect::new(
        NSPoint::new(g.center_x - g.width / 2.0, g.panel_top - height),
        NSSize::new(g.width, height),
    )
}

/// Edge-inclusive, so the very top row of pixels counts as inside.
/// While open, "inside" is the card plus a margin on its sides and bottom,
/// stretched up to the screen top: that covers the gap under the menu bar and
/// the notch hot zone (narrower than the card), so moving from the notch down
/// to the card never closes it.
fn keep_open_rect(frame: NSRect, screen_top: f64, m: f64) -> NSRect {
    let bottom = frame.origin.y - m;
    NSRect::new(
        NSPoint::new(frame.origin.x - m, bottom),
        NSSize::new(frame.size.width + 2.0 * m, screen_top - bottom),
    )
}

fn contains(r: NSRect, p: NSPoint) -> bool {
    p.x >= r.origin.x
        && p.x <= r.origin.x + r.size.width
        && p.y >= r.origin.y
        && p.y <= r.origin.y + r.size.height
}

#[cfg(test)]
mod tests {
    use super::{
        contains, keep_open_rect, panel_rect, Geometry, Inner, Step, GAP, HIT_MARGIN, LEAVE_DELAY, MIN_HEIGHT,
    };
    use objc2_foundation::{NSPoint, NSRect, NSSize};
    use std::time::{Duration, Instant};

    #[test]
    fn opens_in_zone_and_closes_after_delay() {
        let mut s = Inner::default();
        let t = Instant::now();
        assert_eq!(s.step(false, false, t), Step::Stay);
        assert_eq!(s.step(true, false, t), Step::Open);
        assert_eq!(s.step(false, true, t), Step::Stay); // inside the panel
        assert_eq!(s.step(false, false, t), Step::Stay); // leave timer starts
        assert_eq!(s.step(false, false, t + LEAVE_DELAY / 2), Step::Stay);
        assert_eq!(s.step(false, false, t + LEAVE_DELAY), Step::Close);
        assert!(!s.open);
    }

    #[test]
    fn coming_back_resets_the_leave_timer() {
        let mut s = Inner::default();
        let t = Instant::now();
        s.step(true, false, t);
        s.step(false, false, t);
        assert_eq!(s.step(false, true, t + Duration::from_millis(200)), Step::Stay);
        assert_eq!(s.step(false, false, t + Duration::from_millis(400)), Step::Stay);
        assert_eq!(s.step(false, false, t + Duration::from_millis(400) + LEAVE_DELAY), Step::Close);
    }

    #[test]
    fn pinned_never_closes() {
        let mut s = Inner::default();
        let t = Instant::now();
        s.step(true, false, t);
        s.pinned = true;
        assert_eq!(s.step(false, false, t), Step::Stay);
        assert_eq!(s.step(false, false, t + LEAVE_DELAY * 10), Step::Stay);
        s.pinned = false;
        assert_eq!(s.step(false, false, t + LEAVE_DELAY * 10), Step::Stay);
        assert_eq!(s.step(false, false, t + LEAVE_DELAY * 11), Step::Close);
    }

    #[test]
    fn card_floats_below_the_bar_and_respects_the_cap() {
        let g = Geometry {
            zone: NSRect::new(NSPoint::new(650.0, 950.0), NSSize::new(200.0, 32.0)),
            top: 982.0,
            panel_top: 982.0 - 32.0 - GAP,
            center_x: 750.0,
            width: 600.0,
            max_height: 600.0,
        };
        let r = panel_rect(&g, 300.0);
        let top = 982.0 - 32.0 - GAP;
        assert_eq!((r.origin.x, r.origin.y, r.size.width, r.size.height), (450.0, top - 300.0, 600.0, 300.0));
        assert_eq!(panel_rect(&g, 5000.0).size.height, 600.0); // capped → the list scrolls
        assert_eq!(panel_rect(&g, 10.0).size.height, MIN_HEIGHT);
    }

    #[test]
    fn gap_zone_and_margin_keep_it_open() {
        // AppKit origin is bottom-left. Card 600×300 whose top sits GAP below a 32pt bar.
        let screen_top = 982.0;
        let card_top = screen_top - 32.0 - GAP;
        let frame = NSRect::new(NSPoint::new(450.0, card_top - 300.0), NSSize::new(600.0, 300.0));
        let keep = keep_open_rect(frame, screen_top, HIT_MARGIN);
        let inside = |x: f64, y: f64| contains(keep, NSPoint::new(x, y));
        assert!(inside(750.0, card_top + GAP / 2.0)); // the gap under the bar
        assert!(inside(750.0, screen_top)); // the notch / hot zone
        assert!(inside(750.0, frame.origin.y)); // bottom edge (the add row)
        assert!(inside(750.0, frame.origin.y - HIT_MARGIN));
        assert!(inside(450.0 - HIT_MARGIN, card_top + 1.0)); // side margin, up into the gap
        assert!(!inside(750.0, frame.origin.y - HIT_MARGIN - 1.0));
        assert!(!inside(450.0 - HIT_MARGIN - 1.0, 800.0));
        assert!(!inside(750.0, screen_top + 1.0));
    }
}
