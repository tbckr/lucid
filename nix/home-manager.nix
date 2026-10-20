# Home Manager module: services.lucid runs Lucid as a user service, for
# machines without NixOS or root. Linux: a systemd user service, macOS: a
# launchd agent; both start at login, in local or server mode (FR-35).
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.lucid;
  lucidLib = import ./lib.nix { inherit lib; };
  inherit (pkgs.stdenv.hostPlatform) isLinux isDarwin;

  credentials = lucidLib.credentials cfg;

  # A file directly in ~/Library/Logs, which always exists: launchd does not
  # create missing directories.
  log = "${config.home.homeDirectory}/Library/Logs/lucid.log";
in
{
  imports = [ ./options.nix ];

  config = lib.mkIf cfg.enable (
    lib.mkMerge [
      {
        assertions = lucidLib.assertions cfg;
        warnings =
          lib.optional (isLinux && cfg.port < 1024)
            "services.lucid.port ${toString cfg.port} is below 1024, which a systemd user service can only bind if net.ipv4.ip_unprivileged_port_start allows it. Use a reverse proxy or a port of 1024 or higher.";
      }

      (lib.mkIf isLinux {
        systemd.user.services.lucid = {
          Unit = {
            Description = "Lucid CalDAV web client";
            After = [ "network.target" ];
          };
          Service = {
            ExecStart = lib.getExe cfg.package;
            Restart = "on-failure";
            # Quoted like NixOS does, so systemd does not split at spaces.
            Environment = lib.mapAttrsToList (n: v: builtins.toJSON "${n}=${v}") (
              lucidLib.systemdEnvironment cfg
            );
            LoadCredential = lib.mkIf (credentials != [ ]) credentials;

            # The sandboxing of Home Manager's own syncthing user service,
            # known to work across distributions. No ProtectHome or
            # ProtectSystem: in a user service they need unprivileged user
            # namespaces, which Ubuntu 24.04 and later restrict.
            NoNewPrivileges = true;
            PrivateUsers = true;
            RestrictNamespaces = true;
            LockPersonality = true;
            MemoryDenyWriteExecute = true;
            SystemCallArchitectures = "native";
            SystemCallFilter = "@system-service";
          };
          Install.WantedBy = [ "default.target" ];
        };

        # The app-menu entry only opens the browser (local mode, Linux).
        xdg.desktopEntries.lucid = lib.mkIf (cfg.mode == "local") {
          name = "Lucid";
          genericName = "Calendar";
          comment = "Open Lucid in the browser";
          exec = "${lib.getExe' pkgs.xdg-utils "xdg-open"} ${lucidLib.url cfg}";
          icon = "${lucidLib.icon}";
          categories = [
            "Office"
            "Calendar"
          ];
        };
      })

      (lib.mkIf isDarwin {
        launchd.agents.lucid = {
          enable = true;
          config = {
            ProgramArguments = [ (lib.getExe cfg.package) ];
            # launchd has no credentials mechanism: Lucid reads the TLS
            # files directly.
            EnvironmentVariables = lucidLib.environment cfg;
            RunAtLoad = true;
            KeepAlive = {
              Crashed = true;
              SuccessfulExit = false;
            };
            ProcessType = "Background";
            StandardOutPath = log;
            StandardErrorPath = log;
          };
        };
      })
    ]
  );
}
