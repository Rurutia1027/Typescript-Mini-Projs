import { z } from 'zod'; 


// here we define the uniform of the message transfer through the gateway 

export const IRMessageSchema = z
    .object({
        role: z.enum(['system', 'user', 'assistant', 'tool']),
        content: z.union([z.string(), z.array(z.any()), z.null()])
    })
    .passthrough(); 

export const IRChatRequestSchema = z 
    .object({
        model: z.string().min(1), 
        messages: z.array(IRMessageSchema).min(1), 
        max_tokens: z.number().int().positive().optional(), 
        stream: z.boolean().optional(), 
        stream_options: z
            .object({include_usage: z.boolean().optional()})
            .passthrough()
            .optional(), 
    })
    .passthrough(); 

export type IRMessage = z.infer<typeof IRMessageSchema>; 
export type IRChatRequest = z.infer<typeof IRChatRequestSchema>;  