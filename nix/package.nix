# The single lucid binary with the embedded frontend, built like `just build`.
{
  lib,
  buildGoModule,
  stdenvNoCC,
  fetchPnpmDeps,
  pnpmConfigHook,
  pnpm_11,
  nodejs_24,
  version,
  commit ? "none",
  date ? "unknown",
}:
let
  # Same majors as web/package.json (packageManager, engines) and CI.
  pnpm = pnpm_11;
  nodejs = nodejs_24;

  web = stdenvNoCC.mkDerivation (finalAttrs: {
    pname = "lucid-web";
    inherit version;

    src = lib.fileset.toSource {
      root = ../web;
      fileset = lib.fileset.difference ../web (
        lib.fileset.unions [
          (lib.fileset.maybeMissing ../web/node_modules)
          (lib.fileset.maybeMissing ../web/dist)
        ]
      );
    };

    nativeBuildInputs = [
      nodejs
      pnpm
      pnpmConfigHook
    ];

    # Update after changes to web/pnpm-lock.yaml: set to "" and copy the
    # "got:" hash from the failing build.
    pnpmDeps = fetchPnpmDeps {
      inherit (finalAttrs) pname version src;
      inherit pnpm;
      fetcherVersion = 4;
      hash = "sha256-LzchEAjeQJPQT/iyT827rKqgggI10GFnnAXdzZKnxWo=";
    };

    buildPhase = ''
      runHook preBuild
      pnpm build
      runHook postBuild
    '';

    # Same gate as CI: production bundles ship no source maps (NFR-31).
    doCheck = true;
    checkPhase = ''
      runHook preCheck
      if find dist -name '*.map' | grep -q . || grep -rq 'sourceMappingURL=' dist; then
        echo "Source maps must not be shipped (NFR-31)" >&2
        exit 1
      fi
      runHook postCheck
    '';

    installPhase = ''
      runHook preInstall
      cp -r dist $out
      runHook postInstall
    '';
  });
in
buildGoModule {
  pname = "lucid";
  inherit version;

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../go.mod
      ../go.sum
      ../cmd
      ../internal
      ../web/embed.go
    ];
  };

  # Update after changes to go.mod/go.sum: set to "" and copy the "got:" hash
  # from the failing build.
  vendorHash = "sha256-2185DDhPdPu+S1AU1nCCUUK0Wao+jvKvvKHQCOJLtD8=";

  subPackages = [ "cmd/lucid" ];

  env.CGO_ENABLED = 0;

  ldflags = [
    "-s"
    "-w"
    "-X main.version=${version}"
    "-X main.commit=${commit}"
    "-X main.date=${date}"
  ];

  # web/embed.go embeds web/dist (see `just build`).
  preBuild = ''
    cp -r --no-preserve=mode ${web} web/dist
  '';

  passthru = { inherit web; };

  meta = {
    description = "Self-hostable CalDAV web client for calendars and tasks";
    homepage = "https://github.com/tbckr/lucid";
    license = lib.licenses.gpl3Only;
    mainProgram = "lucid";
    platforms = lib.platforms.unix;
  };
}
