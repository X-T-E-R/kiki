macro_rules! app_commands {
    ($callback:ident) => {
        $callback!(
            desktop_connection,
            cancel_desktop_startup,
            show_main_window,
            write_host_file_text,
            reveal_host_path,
            open_host_path,
            read_desktop_prefs,
            write_desktop_prefs,
            check_desktop_update,
            install_desktop_update,
            prepare_for_update,
            restart_server,
        )
    };
}
