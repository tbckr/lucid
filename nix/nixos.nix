# NixOS module: services.lucid runs Lucid as a hardened system service in
# local or server mode (FR-35). There is deliberately no user-service variant:
# a user service runs under the user's own UID and would be less restricted
# than this one. Per-user setups use the Home Manager module.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.lucid;
  lucidLib = import ./lib.nix { inherit lib; };

  credentials = lucidLib.credentials cfg;

  # Binding a port below 1024 needs CAP_NET_BIND_SERVICE in the host's user
  # namespace, which PrivateUsers would take away again.
  lowPort = cfg.port < 1024;
in
{
  imports = [ ./options.nix ];

  options.services.lucid.openFirewall = lib.mkOption {
    type = lib.types.bool;
    default = false;
    description = "Open {option}`port` in the firewall (server mode). The metrics port stays closed.";
  };

  config = lib.mkIf cfg.enable {
    assertions = lucidLib.assertions cfg ++ [
      {
        assertion = !(cfg.mode == "local" && cfg.openFirewall);
        message = lucidLib.serverOnlyMessage "openFirewall";
      }
    ];

    networking.firewall.allowedTCPPorts = lib.mkIf (cfg.mode == "server" && cfg.openFirewall) [
      cfg.port
    ];

    # The app-menu entry only opens the browser; Lucid itself runs as a
    # service.
    environment.systemPackages = lib.mkIf (cfg.mode == "local") [
      (pkgs.makeDesktopItem {
        name = "lucid";
        desktopName = "Lucid";
        genericName = "Calendar";
        comment = "Open Lucid in the browser";
        exec = "${lib.getExe' pkgs.xdg-utils "xdg-open"} ${lucidLib.url cfg}";
        icon = "${lucidLib.icon}";
        categories = [
          "Office"
          "Calendar"
        ];
      })
    ];

    systemd.services.lucid = {
      description = "Lucid CalDAV web client";
      wantedBy = [ "multi-user.target" ];
      # Local mode only binds loopback, so it need not wait for the network
      # (an offline laptop would delay it); a server may bind a configured
      # address.
      wants = lib.optional (cfg.mode == "server") "network-online.target";
      after = [ (if cfg.mode == "server" then "network-online.target" else "network.target") ];

      environment = lucidLib.systemdEnvironment cfg;

      serviceConfig = {
        ExecStart = lib.getExe cfg.package;
        Restart = "on-failure";
        LoadCredential = lib.mkIf (credentials != [ ]) credentials;

        # Hardening (NFR-21): Lucid keeps no state on disk and needs no
        # privileges, like the distroless container. Only a port below 1024
        # gets CAP_NET_BIND_SERVICE, the usual nixpkgs pattern.
        DynamicUser = true;
        AmbientCapabilities = lib.mkIf lowPort [ "CAP_NET_BIND_SERVICE" ];
        CapabilityBoundingSet = if lowPort then [ "CAP_NET_BIND_SERVICE" ] else "";
        NoNewPrivileges = true;
        UMask = "0077";
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        PrivateDevices = true;
        PrivateUsers = !lowPort;
        DevicePolicy = "closed";
        ProtectClock = true;
        ProtectControlGroups = true;
        ProtectHostname = true;
        ProtectKernelLogs = true;
        ProtectKernelModules = true;
        ProtectKernelTunables = true;
        ProtectProc = "invisible";
        ProcSubset = "pid";
        RestrictAddressFamilies = [
          "AF_INET"
          "AF_INET6"
          "AF_UNIX"
        ];
        RestrictNamespaces = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        RemoveIPC = true;
        LockPersonality = true;
        MemoryDenyWriteExecute = true;
        SystemCallArchitectures = "native";
        SystemCallFilter = [
          "@system-service"
          "~@privileged"
        ];
        SystemCallErrorNumber = "EPERM";
      };
    };
  };
}
