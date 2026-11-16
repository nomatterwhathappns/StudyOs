import { createApp } from "./_core/app";

const appPromise = createApp();

export default async function handler(
  req: Parameters<Awaited<typeof appPromise>>[0],
  res: Parameters<Awaited<typeof appPromise>>[1]
) {
  const app = await appPromise;
  return app(req, res);
}
