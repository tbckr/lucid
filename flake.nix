{
  description = "Lucid, a self-hostable CalDAV web client";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { self, nixpkgs }:
    let
      inherit (nixpkgs) lib;

      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f: lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      # Build metadata for `lucid --version`, like `git describe --always
      # --dirty` in the justfile (a flake has no access to tags).
      buildInfo = {
        version = self.shortRev or self.dirtyShortRev or "dev";
        commit = self.rev or self.dirtyRev or "none";
        date =
          let
            d = self.lastModifiedDate or "19700101000000";
            part = start: len: builtins.substring start len d;
          in
          "${part 0 4}-${part 4 2}-${part 6 2}T${part 8 2}:${part 10 2}:${part 12 2}Z";
      };
    in
    {
      packages = forAllSystems (pkgs: rec {
        lucid = pkgs.callPackage ./nix/package.nix buildInfo;
        default = lucid;
      });

      overlays.default = final: _prev: {
        lucid = final.callPackage ./nix/package.nix buildInfo;
      };

      nixosModules.default =
        { lib, pkgs, ... }:
        let
          inherit (pkgs.stdenv.hostPlatform) system;
        in
        {
          imports = [ ./nix/module.nix ];
          services.lucid.package = lib.mkDefault self.packages.${system}.default;
        };

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          # Everything the justfile and CI use. The stdenv C compiler lets
          # `just test` keep the race detector (cgo).
          packages =
            with pkgs;
            [
              go
              golangci-lint
              goreleaser
              jq
              just
              nodejs_24
              pnpm_11
            ]
            ++ lib.optionals stdenv.hostPlatform.isLinux [ chromium ];

          # Playwright's downloaded browsers do not run on NixOS; use the
          # system Chromium instead (see web/playwright.config.ts).
          env = lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
            PLAYWRIGHT_CHROMIUM_EXECUTABLE = lib.getExe pkgs.chromium;
            PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
          };
        };
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt-tree);

      checks = forAllSystems (
        pkgs:
        let
          inherit (pkgs.stdenv.hostPlatform) system;
        in
        {
          package = self.packages.${system}.default;
          devShell = self.devShells.${system}.default;
          nixfmt = pkgs.runCommand "lucid-nixfmt" { nativeBuildInputs = [ pkgs.nixfmt ]; } ''
            nixfmt --check ${./flake.nix} ${./nix}/*.nix
            touch $out
          '';
        }
        // lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          nixos-module = pkgs.testers.runNixOSTest (import ./nix/test.nix { inherit self; });
        }
      );
    };
}
