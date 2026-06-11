export function contentToString(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(c => {
      if (c.type === 'text') return c.text;
      if (c.type === 'image_url') return `[Image: ${c.image_url?.url || ''}]`;
      return JSON.stringify(c);
    }).join('\n');
  }
  return JSON.stringify(content);
}

export function toCCFormatToolCalls(toolCalls) {
  if (!toolCalls || !Array.isArray(toolCalls)) return undefined;
  return toolCalls.map(tc => {
    if (tc.type === 'function' && tc.function) {
      return {
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      };
    }
    return tc;
  });
}

export function toCCMessages(openaiMessages) {
  let system = '';
  const messages = [];

  for (const msg of openaiMessages) {
    if (msg.role === 'system') {
      system += (system ? '\n' : '') + contentToString(msg.content);
    } else if (msg.role === 'tool') {
      messages.push({
        role: 'user',
        content: contentToString(msg.content),
      });
    } else {
      const entry = { role: msg.role, content: contentToString(msg.content) };
      const tc = toCCFormatToolCalls(msg.tool_calls);
      if (tc) entry.tool_calls = tc;
      messages.push(entry);
    }
  }

  return { system, messages };
}

export function toCCTools(openaiTools) {
  if (!openaiTools || openaiTools.length === 0) return [];
  return openaiTools.map(t => {
    if (t.type === 'function' && t.function) {
      return {
        name: t.function.name,
        description: t.function.description || '',
        input_schema: t.function.parameters || {},
      };
    }
    return t;
  });
}

export function convertToolChoice(tc) {
  if (!tc) return undefined;
  if (typeof tc === 'string') return { type: tc };
  if (typeof tc === 'object' && tc.type === 'function' && tc.function?.name) {
    return { type: 'tool', name: tc.function.name };
  }
  return tc;
}
