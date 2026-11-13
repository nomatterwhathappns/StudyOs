import { z } from "zod";
import { aiConnectionInputSchema } from "@shared/ai-connections";
import { publicProcedure, router } from "../_core/trpc";
import { requireAiAccess } from "./access";
import {
  activateConnection,
  deleteConnection,
  listConnections,
  resolveDraftConnection,
  saveConnection,
} from "./connection-store";
import { discoverModels, testConnection } from "./transport";

const settingsProcedure = publicProcedure.use(({ ctx, next }) => {
  requireAiAccess(ctx.req, ctx.user);
  return next();
});
const idInput = z.object({ id: z.string().uuid() });
const probeInput = z
  .object({
    id: z.string().uuid().optional(),
    draft: aiConnectionInputSchema.optional(),
  })
  .refine(
    value => Boolean(value.id || value.draft),
    "Choose a saved connection or provide connection settings first."
  );

export const aiConnectionsRouter = router({
  list: settingsProcedure.query(() => listConnections()),
  save: settingsProcedure
    .input(aiConnectionInputSchema)
    .mutation(({ input }) => saveConnection(input)),
  remove: settingsProcedure
    .input(idInput)
    .mutation(({ input }) => deleteConnection(input.id)),
  activate: settingsProcedure
    .input(idInput)
    .mutation(({ input }) => activateConnection(input.id)),
  test: settingsProcedure
    .input(probeInput)
    .mutation(async ({ input }) =>
      testConnection(await resolveDraftConnection(input))
    ),
  models: settingsProcedure
    .input(probeInput)
    .mutation(async ({ input }) => ({
      models: await discoverModels(await resolveDraftConnection(input)),
    })),
});
