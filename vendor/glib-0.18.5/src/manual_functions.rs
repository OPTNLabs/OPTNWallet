// Take a look at the license at the top of the repository in the LICENSE file.

#[cfg(not(windows))]
use std::boxed::Box as Box_;
#[cfg(not(windows))]
use std::mem;
#[cfg(not(windows))]
#[cfg(feature = "v2_58")]
use std::os::unix::io::AsRawFd;
#[cfg(not(windows))]
use std::os::unix::io::{FromRawFd, IntoRawFd, RawFd};
use std::ptr;

// #[cfg(windows)]
// #[cfg(feature = "v2_58")]
// use std::os::windows::io::AsRawHandle;
use crate::{translate::*, GStr};
#[cfg(not(windows))]
use crate::{Error, Pid, SpawnFlags};

#[cfg(not(windows))]
fn spawn_error(message: &str) -> Error {
    unsafe {
        from_glib_full(ffi::g_error_new_literal(
            ffi::g_spawn_error_quark(),
            ffi::G_SPAWN_ERROR_FAILED,
            message.to_glib_none().0,
        ))
    }
}

#[cfg(feature = "v2_58")]
#[cfg(not(windows))]
#[cfg_attr(docsrs, doc(cfg(all(feature = "v2_58", not(windows)))))]
#[allow(clippy::too_many_arguments)]
#[doc(alias = "g_spawn_async_with_fds")]
pub fn spawn_async_with_fds<P: AsRef<std::path::Path>, T: AsRawFd, U: AsRawFd, V: AsRawFd>(
    working_directory: P,
    argv: &[&str],
    envp: &[&str],
    flags: SpawnFlags,
    child_setup: Option<Box_<dyn FnOnce() + 'static>>,
    stdin_fd: T,
    stdout_fd: U,
    stderr_fd: V,
) -> Result<Pid, Error> {
    let mut child_setup_data: Box_<Option<Box_<dyn FnOnce() + 'static>>> = Box_::new(child_setup);
    unsafe extern "C" fn child_setup_func(user_data: ffi::gpointer) {
        let callback = &mut *(user_data as *mut Option<Box_<dyn FnOnce() + 'static>>);
        let callback = callback.take().expect("cannot get closure...");
        callback()
    }
    let child_setup = if child_setup_data.is_some() {
        Some(child_setup_func as _)
    } else {
        None
    };
    // On Unix the callback consumes the child's forked copy. Keep the parent's
    // box owned here so it is dropped on both success and failure.
    unsafe {
        let mut child_pid = mem::MaybeUninit::uninit();
        let mut error = ptr::null_mut();
        let success = ffi::g_spawn_async_with_fds(
            working_directory.as_ref().to_glib_none().0,
            argv.to_glib_none().0,
            envp.to_glib_none().0,
            flags.into_glib(),
            child_setup,
            &mut *child_setup_data as *mut _ as *mut _,
            child_pid.as_mut_ptr(),
            stdin_fd.as_raw_fd(),
            stdout_fd.as_raw_fd(),
            stderr_fd.as_raw_fd(),
            &mut error,
        );
        if !error.is_null() {
            return Err(from_glib_full(error));
        }
        if success == ffi::GFALSE {
            return Err(spawn_error(
                "g_spawn_async_with_fds failed without a GError",
            ));
        }
        Ok(from_glib(child_pid.assume_init()))
    }
}

// #[cfg(feature = "v2_58")]
// #[cfg(windows)]
// pub fn spawn_async_with_fds<
//     P: AsRef<std::path::Path>,
//     T: AsRawHandle,
//     U: AsRawHandle,
//     V: AsRawHandle,
// >(
//     working_directory: P,
//     argv: &[&str],
//     envp: &[&str],
//     flags: SpawnFlags,
//     child_setup: Option<Box_<dyn FnOnce() + 'static>>,
//     stdin_fd: T,
//     stdout_fd: U,
//     stderr_fd: V,
// ) -> Result<Pid, Error> {
//     let child_setup_data: Box_<Option<Box_<dyn FnOnce() + 'static>>> = Box_::new(child_setup);
//     unsafe extern "C" fn child_setup_func<P: AsRef<std::path::Path>>(
//         user_data: ffi::gpointer,
//     ) {
//         let callback: Box_<Option<Box_<dyn FnOnce() + 'static>>> =
//             Box_::from_raw(user_data as *mut _);
//         let callback = (*callback).expect("cannot get closure...");
//         callback()
//     }
//     let child_setup = if child_setup_data.is_some() {
//         Some(child_setup_func::<P> as _)
//     } else {
//         None
//     };
//     let super_callback0: Box_<Option<Box_<dyn FnOnce() + 'static>>> = child_setup_data;
//     unsafe {
//         let mut child_pid = mem::MaybeUninit::uninit();
//         let mut error = ptr::null_mut();
//         let _ = ffi::g_spawn_async_with_fds(
//             working_directory.as_ref().to_glib_none().0,
//             argv.to_glib_none().0,
//             envp.to_glib_none().0,
//             flags.into_glib(),
//             child_setup,
//             Box_::into_raw(super_callback0) as *mut _,
//             child_pid.as_mut_ptr(),
//             stdin_fd.as_raw_handle() as usize as _,
//             stdout_fd.as_raw_handle() as usize as _,
//             stderr_fd.as_raw_handle() as usize as _,
//             &mut error,
//         );
//         let child_pid = from_glib(child_pid.assume_init());
//         if error.is_null() {
//             Ok(child_pid)
//         } else {
//             Err(from_glib_full(error))
//         }
//     }
// }

#[cfg(not(windows))]
#[cfg_attr(docsrs, doc(cfg(not(windows))))]
#[doc(alias = "g_spawn_async_with_pipes")]
pub fn spawn_async_with_pipes<
    P: AsRef<std::path::Path>,
    T: FromRawFd,
    U: FromRawFd,
    V: FromRawFd,
>(
    working_directory: P,
    argv: &[&std::path::Path],
    envp: &[&std::path::Path],
    flags: SpawnFlags,
    child_setup: Option<Box_<dyn FnOnce() + 'static>>,
) -> Result<(Pid, T, U, V), Error> {
    let incompatible_flags = SpawnFlags::CHILD_INHERITS_STDIN
        | SpawnFlags::STDOUT_TO_DEV_NULL
        | SpawnFlags::STDERR_TO_DEV_NULL;
    #[cfg(feature = "v2_74")]
    let incompatible_flags = incompatible_flags
        | SpawnFlags::STDIN_FROM_DEV_NULL
        | SpawnFlags::CHILD_INHERITS_STDOUT
        | SpawnFlags::CHILD_INHERITS_STDERR;
    // This signature requires all three pipes. Unknown flags may also suppress
    // them when running against a newer GLib than the enabled feature level.
    if flags.intersects(incompatible_flags) || !SpawnFlags::all().contains(flags) {
        return Err(spawn_error(
            "spawn_async_with_pipes requires all three pipes",
        ));
    }

    let mut child_setup_data: Box_<Option<Box_<dyn FnOnce() + 'static>>> = Box_::new(child_setup);
    unsafe extern "C" fn child_setup_func(user_data: ffi::gpointer) {
        let callback = &mut *(user_data as *mut Option<Box_<dyn FnOnce() + 'static>>);
        let callback = callback.take().expect("cannot get closure...");
        callback()
    }
    let child_setup = if child_setup_data.is_some() {
        Some(child_setup_func as _)
    } else {
        None
    };
    // GLib invokes this only in the forked child, which has its own copy.
    // Retain ownership in the parent until the C call returns.
    unsafe {
        let mut child_pid = mem::MaybeUninit::uninit();
        let mut standard_input = mem::MaybeUninit::uninit();
        let mut standard_output = mem::MaybeUninit::uninit();
        let mut standard_error = mem::MaybeUninit::uninit();
        let mut error = ptr::null_mut();
        let success = ffi::g_spawn_async_with_pipes(
            working_directory.as_ref().to_glib_none().0,
            argv.to_glib_none().0,
            envp.to_glib_none().0,
            flags.into_glib(),
            child_setup,
            &mut *child_setup_data as *mut _ as *mut _,
            child_pid.as_mut_ptr(),
            standard_input.as_mut_ptr(),
            standard_output.as_mut_ptr(),
            standard_error.as_mut_ptr(),
            &mut error,
        );
        if !error.is_null() {
            return Err(from_glib_full(error));
        }
        if success == ffi::GFALSE {
            return Err(spawn_error(
                "g_spawn_async_with_pipes failed without a GError",
            ));
        }
        // GLib initializes these outputs only on success, with pipes enabled.
        Ok((
            from_glib(child_pid.assume_init()),
            FromRawFd::from_raw_fd(standard_input.assume_init()),
            FromRawFd::from_raw_fd(standard_output.assume_init()),
            FromRawFd::from_raw_fd(standard_error.assume_init()),
        ))
    }
}

// rustdoc-stripper-ignore-next
/// Obtain the character set for the current locale.
///
/// This returns whether the locale's encoding is UTF-8, and the current
/// charset if available.
#[doc(alias = "g_get_charset")]
#[doc(alias = "get_charset")]
pub fn charset() -> (bool, Option<&'static GStr>) {
    unsafe {
        let mut out_charset = ptr::null();
        let is_utf8 = from_glib(ffi::g_get_charset(&mut out_charset));
        let charset = from_glib_none(out_charset);
        (is_utf8, charset)
    }
}

#[cfg(unix)]
#[doc(alias = "g_unix_open_pipe")]
pub fn unix_open_pipe(flags: i32) -> Result<(RawFd, RawFd), Error> {
    unsafe {
        let mut fds = [0, 2];
        let mut error = ptr::null_mut();
        let _ = ffi::g_unix_open_pipe(&mut fds, flags, &mut error);
        if error.is_null() {
            Ok((
                FromRawFd::from_raw_fd(fds[0]),
                FromRawFd::from_raw_fd(fds[1]),
            ))
        } else {
            Err(from_glib_full(error))
        }
    }
}

#[cfg(unix)]
#[doc(alias = "g_file_open_tmp")]
pub fn file_open_tmp(
    tmpl: Option<impl AsRef<std::path::Path>>,
) -> Result<(RawFd, std::path::PathBuf), crate::Error> {
    unsafe {
        let mut name_used = ptr::null_mut();
        let mut error = ptr::null_mut();
        let ret = ffi::g_file_open_tmp(
            tmpl.as_ref().map(|p| p.as_ref()).to_glib_none().0,
            &mut name_used,
            &mut error,
        );
        if error.is_null() {
            Ok((ret.into_raw_fd(), from_glib_full(name_used)))
        } else {
            Err(from_glib_full(error))
        }
    }
}

// rustdoc-stripper-ignore-next
/// Spawn a new infallible `Future` on the thread-default main context.
///
/// This can be called from any thread and will execute the future from the thread
/// where main context is running, e.g. via a `MainLoop`.
pub fn spawn_future<R: Send + 'static, F: std::future::Future<Output = R> + Send + 'static>(
    f: F,
) -> crate::JoinHandle<R> {
    let ctx = crate::MainContext::ref_thread_default();
    ctx.spawn(f)
}

// rustdoc-stripper-ignore-next
/// Spawn a new infallible `Future` on the thread-default main context.
///
/// The given `Future` does not have to be `Send`.
///
/// This can be called only from the thread where the main context is running, e.g.
/// from any other `Future` that is executed on this main context, or after calling
/// `with_thread_default` or `acquire` on the main context.
pub fn spawn_future_local<R: 'static, F: std::future::Future<Output = R> + 'static>(
    f: F,
) -> crate::JoinHandle<R> {
    let ctx = crate::MainContext::ref_thread_default();
    ctx.spawn_local(f)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[cfg(feature = "v2_58")]
    use std::os::fd::AsFd;
    use std::{
        fs::File,
        io::{Read, Write},
        path::Path,
        rc::Rc,
    };

    #[test]
    fn spawn_wrappers_fail_closed_and_release_resources() {
        fn reap(pid: Pid) {
            let mut status = 0;
            loop {
                let result = unsafe { libc::waitpid(pid.0, &mut status, 0) };
                if result == -1
                    && std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted
                {
                    continue;
                }
                assert_eq!(result, pid.0);
                break;
            }
            unsafe { ffi::g_spawn_close_pid(pid.0) };
            assert!(libc::WIFEXITED(status));
            assert_eq!(libc::WEXITSTATUS(status), 0);
        }

        let directory = tempfile::tempdir().unwrap();
        let missing = directory.path().join("missing");
        let captures = Rc::new(());
        let child_setup = || -> Option<Box_<dyn FnOnce()>> {
            let captures = Rc::clone(&captures);
            Some(Box_::new(move || {
                drop(captures);
                // Only an async-signal-safe write after fork; prove setup ran.
                unsafe { libc::write(2, b"setup\n".as_ptr().cast(), 6) };
            }))
        };
        let assert_error = |error: Error, code| {
            let error: *const ffi::GError = error.to_glib_none().0;
            unsafe {
                assert_eq!((*error).domain, ffi::g_spawn_error_quark());
                assert_eq!((*error).code, code);
            }
            assert_eq!(Rc::strong_count(&captures), 1);
        };
        let flags = SpawnFlags::DO_NOT_REAP_CHILD | SpawnFlags::CLOEXEC_PIPES;
        let expect_empty_argv = |empty| {
            if empty {
                // Assert the one intentional C precondition diagnostic, keeping
                // every unexpected GLib critical fatal under the CI environment.
                unsafe {
                    ffi::g_test_expect_message(
                        b"GLib\0".as_ptr().cast(),
                        ffi::G_LOG_LEVEL_CRITICAL,
                        b"*assertion*argv[0] != NULL*failed*\0".as_ptr().cast(),
                    );
                }
            }
        };
        let assert_expected_messages = || unsafe {
            ffi::g_test_assert_expected_messages_internal(
                b"GLib\0".as_ptr().cast(),
                concat!(file!(), "\0").as_ptr().cast(),
                line!() as i32,
                b"spawn_wrappers_fail_closed_and_release_resources\0"
                    .as_ptr()
                    .cast(),
            );
        };

        // Empty argv deliberately exercises GLib's FALSE-without-GError path.
        for (cwd, argv, code) in [
            (
                directory.path(),
                &[missing.as_path()][..],
                ffi::G_SPAWN_ERROR_NOENT,
            ),
            (
                missing.as_path(),
                &[Path::new("/bin/sh")][..],
                ffi::G_SPAWN_ERROR_CHDIR,
            ),
            (directory.path(), &[][..], ffi::G_SPAWN_ERROR_FAILED),
        ] {
            expect_empty_argv(argv.is_empty());
            assert_error(
                spawn_async_with_pipes::<_, File, File, File>(cwd, argv, &[], flags, child_setup())
                    .unwrap_err(),
                code,
            );
            assert_expected_messages();
            #[cfg(feature = "v2_58")]
            {
                let null = File::options()
                    .read(true)
                    .write(true)
                    .open("/dev/null")
                    .unwrap();
                let argv: Vec<_> = argv.iter().map(|arg| arg.to_str().unwrap()).collect();
                expect_empty_argv(argv.is_empty());
                assert_error(
                    spawn_async_with_fds(
                        cwd,
                        &argv,
                        &[],
                        flags,
                        child_setup(),
                        null.as_fd(),
                        null.as_fd(),
                        null.as_fd(),
                    )
                    .unwrap_err(),
                    code,
                );
                assert_expected_messages();
            }
        }

        for incompatible in [
            SpawnFlags::CHILD_INHERITS_STDIN,
            SpawnFlags::STDOUT_TO_DEV_NULL,
            SpawnFlags::STDERR_TO_DEV_NULL,
            #[cfg(feature = "v2_74")]
            SpawnFlags::STDIN_FROM_DEV_NULL,
            #[cfg(feature = "v2_74")]
            SpawnFlags::CHILD_INHERITS_STDOUT,
            #[cfg(feature = "v2_74")]
            SpawnFlags::CHILD_INHERITS_STDERR,
            SpawnFlags::from_bits_retain(!SpawnFlags::all().bits()),
        ] {
            // A missing executable must not mask rejection before spawning.
            let error = spawn_async_with_pipes::<_, File, File, File>(
                directory.path(),
                &[missing.as_path()],
                &[],
                flags | incompatible,
                child_setup(),
            )
            .unwrap_err();
            assert_eq!(
                error.message(),
                "spawn_async_with_pipes requires all three pipes"
            );
            assert_error(error, ffi::G_SPAWN_ERROR_FAILED);
        }

        let command = "IFS= read -r line; printf '%s\n' \"$line\"; printf 'stderr\n' >&2";
        let (pid, mut stdin, mut stdout, mut stderr) =
            spawn_async_with_pipes::<_, File, File, File>(
                directory.path(),
                &[Path::new("/bin/sh"), Path::new("-c"), Path::new(command)],
                &[],
                flags,
                child_setup(),
            )
            .unwrap();
        assert_eq!(Rc::strong_count(&captures), 1);
        stdin.write_all(b"roundtrip\n").unwrap();
        drop(stdin);
        let (mut output, mut errors) = (String::new(), String::new());
        stdout.read_to_string(&mut output).unwrap();
        stderr.read_to_string(&mut errors).unwrap();
        drop((stdout, stderr));
        reap(pid);
        assert_eq!(output, "roundtrip\n");
        assert_eq!(errors, "setup\nstderr\n");

        #[cfg(feature = "v2_58")]
        {
            use std::io::{Seek, SeekFrom};

            let mut stdin = tempfile::tempfile().unwrap();
            let mut stdout = tempfile::tempfile().unwrap();
            let mut stderr = tempfile::tempfile().unwrap();
            stdin.write_all(b"roundtrip\n").unwrap();
            stdin.seek(SeekFrom::Start(0)).unwrap();
            let pid = spawn_async_with_fds(
                directory.path(),
                &["/bin/sh", "-c", command],
                &[],
                flags,
                child_setup(),
                stdin.as_fd(),
                stdout.as_fd(),
                stderr.as_fd(),
            )
            .unwrap();
            assert_eq!(Rc::strong_count(&captures), 1);
            reap(pid);
            stdout.seek(SeekFrom::Start(0)).unwrap();
            stderr.seek(SeekFrom::Start(0)).unwrap();
            output.clear();
            errors.clear();
            stdout.read_to_string(&mut output).unwrap();
            stderr.read_to_string(&mut errors).unwrap();
            drop((stdin, stdout, stderr));
            assert_eq!(output, "roundtrip\n");
            assert_eq!(errors, "setup\nstderr\n");
        }
    }
}
