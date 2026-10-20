# Tests for Lucid's Home Manager module. A flake of its own so that Home
# Manager does not become an input of the main flake, and so of every flake
# that uses Lucid. Run: nix flake check ./nix/tests/home-manager
{
  description = "Tests for Lucid's Home Manager module";

  inputs = {
    lucid.url = "path:../../..";
    nixpkgs.follows = "lucid/nixpkgs";
    home-manager = {
      url = "github:nix-community/home-manager/release-26.05";
      inputs.nixpkgs.follows = "lucid/nixpkgs";
    };
  };

  outputs =
    {
      lucid,
      nixpkgs,
      home-manager,
      ...
    }:
    let
      inherit (nixpkgs) lib;

      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      # The Home Manager configuration of a user alice with services.lucid.
      hmConfiguration =
        system: cfg:
        home-manager.lib.homeManagerConfiguration {
          pkgs = nixpkgs.legacyPackages.${system};
          modules = [
            lucid.homeModules.default
            {
              home = {
                username = "alice";
                homeDirectory = if lib.hasSuffix "darwin" system then "/Users/alice" else "/home/alice";
                stateVersion = "26.05";
              };
              services.lucid = {
                enable = true;
              }
              // cfg;
            }
          ];
        };
    in
    {
      checks = lib.genAttrs systems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          eval = import ./eval.nix {
            inherit
              pkgs
              nixpkgs
              lucid
              hmConfiguration
              ;
          };
        }
      );
    };
}
