/** @type {import('next').NextConfig} */
const apiUrl = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

const nextConfig = {
  // The browser calls /api/* on the dashboard's own origin; Next forwards to
  // the API, so the API needs no CORS and its URL never matters to the client.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiUrl}/:path*` }];
  },
};

module.exports = nextConfig;
