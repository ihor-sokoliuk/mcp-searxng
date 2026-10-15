{
  description = "mcp-searxng patched for Unix socket transport";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = { self, nixpkgs }:
    let
      supported = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems =
        nixpkgs.lib.genAttrs supported;
    in
    {
      packages = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.buildNpmPackage {
            pname = "mcp-searxng";
            version = "2.6.0-socket";
            src = ./.;
            npmDepsHash = "sha256-+df6oLBlw8fE6baGs2G5Vmn2lQvyfLhg/2s9axuVNwo=";
            meta.mainProgram = "mcp-searxng";
          };
        });
    };
}
