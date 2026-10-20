# Runs evaluation tests (lib.runTests) as a check: evaluating the derivation
# throws on failures, so `nix flake check --no-build` already runs them.
{
  pkgs,
  name,
  tests,
}:
let
  failures = pkgs.lib.runTests tests;
in
if failures == [ ] then
  pkgs.runCommand name { } "touch $out"
else
  throw "${name}: ${toString (builtins.length failures)} failed:\n${
    pkgs.lib.generators.toPretty { } failures
  }"
