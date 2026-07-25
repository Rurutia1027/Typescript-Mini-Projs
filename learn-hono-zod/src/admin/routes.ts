/**
 * Sub-app mounted with app.route('/admin', ...).
 * Per-route inline Zod schemas + safeParse + error.format(). 
*/

import { Hono } from 'hono'; 
import { z } from 'zod'; 
import { requireAdminToken } from '../auth/middleware.js'; 

export function createAdminRouter(adminToken: string) {
    const app = new Hono(); 

    app.use('*', requireAdminToken(adminToken)); 

    app.get('/health', (c) => c.json({ok: true, service: 'learn-hono-zod-admin'})); 

    const CreateKeySchema = z.object({
        userId: z.string().min(1), 
        scopes: z.array(z.string()).default(['chat']), 
    }); 

    app.post('/keys', async (c) => {
        const raw = await c.req.json().catch(() => null); 
        const parsed = CreateKeySchema.safeParse(raw); 
        if (!parsed.success) {
            return c.json(
                {
                    error: {
                        message: 'validation failed', 
                        detail: parsed.error.format(), 
                    }, 
                }, 
                400, 
            ); 
        }

        // Demo only -- no persistence. 
        return c.json(
            {
                key: `sk-gw-${parsed.data.userId}-${Math.random().toString(36).slice(2, 8)}`, 
                scopes: parsed.data.scopes, 
            }, 
            201
        )
    }); 

    return app; 
}