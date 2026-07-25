/**
 * Intermediate Representation (IR) schemas — same style as book-llm-gateway.
 *
 * Patterns covered:
 * - z.object(...).passthrough() so unknown vendor fields survive validation
 * - nested passthrough (stream_options)
 * - z.infer<> exported types for handlers
 */

import { z } from 'zod'; 

export const IRMessageSchema = z
.object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.string().min(1), 
})

export const IRChatRequestSchema = z.object({
    model: z.string().min(1), 
    messages: z.array(IRMessageSchema).min(1), // at least 1 element in the array of IRMessageSchema array for the field of messages 
    temperature: z.number().optional(),
    max_tokens: z.number().int().positive().optional(), 
    top_p: z.number().optional(),
    stream: z.boolean().optional(),
    stream_options: z.object({include_usage: z.boolean().optional()})
    .passthrough()
    .optional(), 
    tools: z.array(z.any()).optional(), 
    tool_choice: z.any().optional(), 
})
.passthrough(); 

export type IRMessage = z.infer<typeof IRMessageSchema>;
export type IRChatRequest = z.infer<typeof IRChatRequestSchema>;