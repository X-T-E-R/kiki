macro_rules! app_commands {
    ($callback:ident) => {
        $callback!(
            desktop_connection,
            cancel_desktop_startup,
            show_main_window,
            write_host_file_text,
            reveal_host_path,
            open_host_path,
            open_external_url,
            read_desktop_prefs,
            write_desktop_prefs,
            supports_desktop_updates,
            check_desktop_update,
            install_desktop_update,
            prepare_for_update,
            restart_server,
        )
    };
}
