# Options of services.lucid, shared by the NixOS and the Home Manager module
# so the two cannot drift. Each maps to a LUCID_* variable (README,
# "Configuration"); nix/lib.nix renders them.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (lib) mkOption types;
  cfg = config.services.lucid;

  goDuration = types.strMatching "([0-9]+(\\.[0-9]*)?(ns|us|µs|μs|ms|s|m|h))+" // {
    description = "Go duration (e.g. 90s, 15m, 12h)";
  };

  # Tuning options are null unless set, so Lucid's own defaults apply.
  tuning =
    type: variable: default: description:
    mkOption {
      type = types.nullOr type;
      default = null;
      description = "${description} (`${variable}`). `null` keeps Lucid's default, ${default}.";
    };
in
{
  options.services.lucid = {
    enable = lib.mkEnableOption "Lucid, a self-hostable CalDAV web client";

    package = lib.mkPackageOption pkgs "lucid" { };

    mode = mkOption {
      type = types.enum [
        "local"
        "server"
      ];
      default = "local";
      description = ''
        `local` (FR-35): Lucid listens on `127.0.0.1` only and serves plain
        HTTP; open `http://127.0.0.1:<port>/` in a browser on the same
        machine. `server`: Lucid listens on {option}`address` behind a
        TLS-terminating reverse proxy or serves TLS itself ({option}`tls`).
      '';
    };

    port = mkOption {
      type = types.port;
      default = if cfg.mode == "local" then 3456 else 8080;
      defaultText = lib.literalMD "`3456` in local mode, `8080` in server mode";
      description = ''
        Port Lucid listens on (`LUCID_LOCAL_PORT` in local mode, the port of
        `LUCID_ADDR` in server mode). Lucid does not fall back to another port
        if it is taken.
      '';
    };

    address = mkOption {
      type = types.str;
      default = "127.0.0.1";
      example = "0.0.0.0";
      description = ''
        Address Lucid listens on in server mode (the host of `LUCID_ADDR`).
        The default only lets a reverse proxy on the same machine reach it.
      '';
    };

    trustProxyHeaders = mkOption {
      type = types.bool;
      default = false;
      description = ''
        Take the client IP for rate limiting and logs from `X-Forwarded-For`
        (`LUCID_TRUST_PROXY_HEADERS`, server mode). Enable only if Lucid is
        reachable exclusively through a reverse proxy, of any kind.
      '';
    };

    tls = {
      certFile = mkOption {
        type = types.nullOr types.externalPath;
        default = null;
        example = "/var/lib/acme/calendar.example.com/fullchain.pem";
        description = ''
          Certificate file for serving HTTPS directly (`LUCID_TLS_CERT`,
          server mode, NFR-04). Read at start only: renewing it needs a
          restart, which signs everyone out.
        '';
      };
      keyFile = mkOption {
        type = types.nullOr types.externalPath;
        default = null;
        example = "/var/lib/acme/calendar.example.com/key.pem";
        description = ''
          Private key for {option}`tls.certFile` (`LUCID_TLS_KEY`). Passed in
          with systemd credentials where available, so the service needs no
          read access to the original file. Never in the Nix store.
        '';
      };
    };

    metrics = {
      enable = mkOption {
        type = types.bool;
        default = false;
        description = "Serve Prometheus `/metrics` on a separate listener (`LUCID_METRICS_ADDR`, server mode).";
      };
      address = mkOption {
        type = types.str;
        default = "127.0.0.1";
        description = "Address of the metrics listener. Keep it internal.";
      };
      port = mkOption {
        type = types.port;
        example = 9100;
        description = "Port of the metrics listener; required with {option}`metrics.enable`.";
      };
    };

    privateNetworks = mkOption {
      type = types.nullOr (
        types.either (types.enum [
          "all"
          "none"
        ]) (types.nonEmptyListOf types.str)
      );
      default = null;
      example = [ "192.168.1.10/32" ];
      description = ''
        Internal addresses CalDAV servers may have (`LUCID_PRIVATE_NETWORKS`,
        NFR-22): `"all"`, `"none"`, or a list of CIDRs and addresses. `null`
        keeps Lucid's default: `all` in local mode, `none` in server mode.
      '';
    };

    session = {
      ttl = tuning goDuration "LUCID_SESSION_TTL" "`12h`" "Absolute session lifetime";
      idleTimeout =
        tuning goDuration "LUCID_SESSION_IDLE_TIMEOUT" "`2h`"
          "Idle timeout, at most {option}`session.ttl`";
    };

    rateLimit = {
      rps =
        tuning types.numbers.positive "LUCID_RATE_LIMIT_RPS" "`20`"
          "Token bucket refill per client IP (API)";
      burst = tuning types.ints.positive "LUCID_RATE_LIMIT_BURST" "`60`" "Token bucket size";
      loginPerMinute =
        tuning types.ints.positive "LUCID_LOGIN_RATE_LIMIT_PER_MIN" "`10`"
          "Login attempts per client IP per minute";
    };

    cache = {
      size =
        tuning types.ints.positive "LUCID_CACHE_SIZE" "`256`"
          "Cached entries (LRU), one per user, calendar and component";
      freshness =
        tuning goDuration "LUCID_CACHE_FRESHNESS" "`10s`"
          "How long the cache is served without a CTag check";
    };

    upstreamTimeout =
      tuning goDuration "LUCID_UPSTREAM_TIMEOUT" "`20s`"
        "Timeout for requests to CalDAV servers";

    logLevel = tuning (types.enum [
      "debug"
      "info"
      "warn"
      "error"
    ]) "LUCID_LOG_LEVEL" "`info`" "Log level";
  };
}
