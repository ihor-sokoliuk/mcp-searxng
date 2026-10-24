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
            version = "2.7.0";
            src = ./.;
            npmDepsHash = "sha256-IEeOBd32jlcb7mEveRNKuMKEqZs3eDpdxN4N567TmvU=";
            meta.mainProgram = "mcp-searxng";
          };
        });
    };
}
