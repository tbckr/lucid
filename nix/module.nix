# NixOS module: services.lucid runs Lucid as a hardened systemd service.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.lucid;
  toEnv = value: if lib.isBool value then lib.boolToString value else toString value;
in
{
  imports = [
    (lib.mkRemovedOptionModule [
      "services"
      "lucid"
      "environmentFile"
    ] "Lucid's configuration holds no secrets any more: the session key is random per start.")
  ];

  options.services.lucid = {
    enable = lib.mkEnableOption "Lucid, a self-hostable CalDAV web client";

    package = lib.mkPackageOption pkgs "lucid" { };

    settings = lib.mkOption {
      type = lib.types.submodule {
        freeformType =
          with lib.types;
          attrsOf (oneOf [
            str
            int
            bool
          ]);
        options.LUCID_ADDR = lib.mkOption {
          type = lib.types.str;
          # Like compose.yaml: only the local reverse proxy reaches Lucid.
          default = "127.0.0.1:8080";
          description = "Listen address.";
        };
      };
      default = { };
      example = {
        LUCID_TRUST_PROXY_HEADERS = true;
        LUCID_PRIVATE_NETWORKS = "192.168.1.10/32";
      };
      description = ''
        `LUCID_*` environment variables, see the configuration table in the
        README.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    systemd.services.lucid = {
      description = "Lucid CalDAV web client";
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ];
      after = [ "network-online.target" ];

      environment = lib.mapAttrs (_: toEnv) cfg.settings;

      serviceConfig = {
        ExecStart = lib.getExe cfg.package;
        Restart = "on-failure";

        # Hardening (NFR-21): Lucid keeps no state on disk and needs no
        # privileges, like the distroless container.
        DynamicUser = true;
        CapabilityBoundingSet = "";
        NoNewPrivileges = true;
        UMask = "0077";
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        PrivateDevices = true;
        PrivateUsers = true;
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
