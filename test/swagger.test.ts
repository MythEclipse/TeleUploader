import { describe, expect, it } from 'bun:test';
import { handleSwaggerHtml, handleSwaggerJson } from '../src/routes/swagger';

describe('Swagger Documentation Endpoints', () => {
  it('returns OpenAPI specification JSON', async () => {
    const res = await handleSwaggerJson();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');

    const body = (await res.json()) as any;
    expect(body.openapi).toBe('3.0.0');
    expect(body.info.title).toBe('TeleUploader API');
    expect(body.paths).toHaveProperty('/health');
    expect(body.paths).toHaveProperty('/api/upload');
    expect(body.paths).toHaveProperty('/f/{public_id}');
    expect(body.paths).toHaveProperty('/file/{public_id}/info');
    expect(body.paths['/api/upload'].post.requestBody.content).toHaveProperty(
      'multipart/form-data',
    );
    expect(body.paths['/api/upload'].post.requestBody.content).toHaveProperty('application/json');
  });

  it('returns Swagger UI HTML page', async () => {
    const res = await handleSwaggerHtml();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');

    const html = await res.text();
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('swagger-ui');
    expect(html).toContain('/swagger.json');
    expect(html).toContain('swagger-ui-bundle.js');
  });
});
