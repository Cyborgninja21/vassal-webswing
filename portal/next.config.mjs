/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output → small self-contained runtime image (Dockerfile copies .next/standalone).
  output: "standalone",
  // protobufjs loads the vendored .proto files from disk at runtime and `ws` is a
  // native-ish server-only dep; keep both out of the bundler's traced graph.
  serverExternalPackages: ["protobufjs", "ws"],
  eslint: {
    // CI runs `next lint` as its own step; don't fail `next build` on lint.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
