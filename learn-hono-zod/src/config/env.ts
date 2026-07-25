/**
 * Ch12-style env validation with Zod.
 * Fail fast at process start — do not start the server with bad config.
 */

import { z } from "zod";

const intFromString = z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? undefined : parseInt(v)))
    .pipe(z.number().int().positive().optional())

const EnvSchema = z.object({
    PORT: intFromString,
    ADMIN_TOKEN: z.string().min(8).default("dev-admin-token-change-me"), 
    // Demo keys: plaintest list for learning (book uses hashed keys in SQLite). 
    GATEWAY_KEYS: z
    .string()
    .default('sk-gw-alice,sk-gw-bob')
    .transform((s) =>
    s.trim()
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean), 
    ), 
})

export type AppEnv = z.infer<typeof EnvSchema>

export function loadEnv(): AppEnv {
    const parsed = EnvSchema.safeParse(process.env); 
    if (!parsed.success) {
        console.error('Invalid environment: ', parsed.error.format()); 
        process.exit(1)
    }
    return {
        ...parsed.data,
        PORT: parsed.data.PORT ?? 3101,
    }
}