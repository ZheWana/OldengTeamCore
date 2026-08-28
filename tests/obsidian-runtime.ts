interface RequestUrlInput {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: ArrayBuffer;
}

export async function requestUrl(input: RequestUrlInput) {
  const response = await fetch(input.url, {
    method: input.method,
    headers: input.headers,
    body: input.body ? new Uint8Array(input.body) : undefined
  });
  const arrayBuffer = await response.arrayBuffer();
  const text = new TextDecoder().decode(arrayBuffer);
  const contentType = response.headers.get("content-type") ?? "";
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    arrayBuffer,
    text,
    json: text && /application\/json/i.test(contentType) ? JSON.parse(text) : undefined
  };
}
