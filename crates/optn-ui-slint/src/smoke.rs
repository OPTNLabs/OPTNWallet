//! Connected native-window check; uses only a new disposable Chipnet config.
use super::*;
use std::{io::Write, path::Path, time::Duration};

fn snapshot(ui: &NetworkWindow, path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let pixels = ui.window().take_snapshot()?;
    let (width, height) = (pixels.width(), pixels.height());
    let size = width * height * 4;
    let mut file = std::fs::File::create(path)?;
    file.write_all(b"BM")?;
    for value in [size + 54, 0, 54, 40, width, (-(height as i32)) as u32] {
        file.write_all(&value.to_le_bytes())?;
    }
    file.write_all(&1u16.to_le_bytes())?;
    file.write_all(&32u16.to_le_bytes())?;
    for value in [0, size, 0, 0, 0, 0] {
        file.write_all(&value.to_le_bytes())?;
    }
    for p in pixels.as_slice() {
        file.write_all(&[p.b, p.g, p.r, 255])?;
    }
    Ok(())
}

pub(super) fn run(
    ui: &NetworkWindow,
    host: Rc<RefCell<Host>>,
    directory: PathBuf,
) -> Result<(), Box<dyn std::error::Error>> {
    std::fs::create_dir_all(&directory)?;
    ui.show()?;
    let bootstrap = host
        .borrow()
        .snapshot
        .sources
        .iter()
        .find(|s| !s.can_remove)
        .unwrap()
        .id
        .clone();
    ui.invoke_open_source(bootstrap.clone().into());
    assert!(!ui.get_removable());
    ui.invoke_disposition("banned".into());
    assert_eq!(
        host.borrow()
            .settings
            .read()?
            .sources
            .iter()
            .find(|s| s.id == bootstrap)
            .unwrap()
            .disposition,
        "banned"
    );
    ui.invoke_navigate(6);
    ui.set_source_name("Pilot home".into());
    ui.set_source_host("pilot.example".into());
    ui.invoke_navigate(7);
    assert_eq!(ui.get_page(), 7);
    ui.invoke_add_source();
    let id = host
        .borrow()
        .snapshot
        .sources
        .iter()
        .find(|s| s.can_remove)
        .expect("added source")
        .id
        .clone();
    ui.invoke_open_source(id.clone().into());
    assert!(ui.get_removable());
    ui.invoke_pin_source();
    ui.invoke_prefer_source();
    let reopened = host.borrow().settings.read()?;
    assert_eq!(
        reopened.selection.primary_scope,
        Scope::Selected(vec![id.clone()])
    );
    assert_eq!(reopened.selection.preferred, vec![id.clone()]);
    assert!(reopened.selection.fallback_scope.is_none());
    ui.invoke_navigate(5);
    ui.set_primary_scope(3);
    ui.invoke_select_source(bootstrap.clone().into(), false, true);
    ui.invoke_save_routing();
    let policy = host.borrow().settings.read()?.selection;
    assert_eq!(selected(&policy.primary_scope).len(), 2);
    assert!(host
        .borrow()
        .settings
        .read()?
        .sources
        .iter()
        .find(|s| s.id == bootstrap)
        .is_some_and(|s| s.disposition == "banned"));
    ui.invoke_open_source(id.into());
    ui.invoke_remove_source();
    let reopened = host.borrow().settings.read()?;
    assert_eq!(
        reopened.selection.primary_scope,
        Scope::Selected(vec![bootstrap])
    );
    assert!(reopened.selection.preferred.is_empty());
    assert!(reopened.selection.fallback_scope.is_none());
    ui.invoke_preset("auto".into());
    assert_eq!(host.borrow().settings.read()?.preset, "auto");
    ui.invoke_navigate(0);
    let weak = ui.as_weak();
    let timer = slint::Timer::default();
    let mut step = 0;
    timer.start(slint::TimerMode::Repeated, Duration::from_millis(700), move || {
        let ui = weak.unwrap();
        match step {
            0 => ui.window().set_size(slint::LogicalSize::new(1100., 760.)),
            1 => { snapshot(&ui, &directory.join("desktop.bmp")).unwrap(); ui.invoke_navigate(1); }
            2 => { snapshot(&ui, &directory.join("directory.bmp")).unwrap(); ui.window().set_size(slint::LogicalSize::new(390., 844.)); }
            3 => { snapshot(&ui, &directory.join("narrow.bmp")).unwrap(); ui.window().set_maximized(true); }
            4 => { assert!(ui.window().is_maximized()); snapshot(&ui, &directory.join("maximized.bmp")).unwrap(); ui.window().set_maximized(false); ui.window().set_minimized(true); }
            5 => { assert!(ui.window().is_minimized()); ui.window().set_minimized(false); },
            6 => { assert!(!ui.window().is_minimized()); ui.window().set_size(slint::LogicalSize::new(1100., 760.)); ui.invoke_navigate(5); }
            7 => {
                snapshot(&ui, &directory.join("restored-routing.bmp")).unwrap();
                ui.window().set_size(slint::LogicalSize::new(1000., 480.));
            }
            8 => {
                snapshot(&ui, &directory.join("short-routing.bmp")).unwrap();
                std::fs::write(directory.join("PASS.txt"), "Native Slint callbacks: add, pin, prefer, explicit pool, ban, remove, auto, persisted reread PASS. Native snapshots: desktop, directory, narrow, maximize, minimize/restore, routing. No network, wallet, signing, Android or macOS test.\n").unwrap();
                slint::quit_event_loop().unwrap();
            }
            _ => {}
        }
        step += 1;
    });
    slint::run_event_loop()?;
    Ok(())
}
