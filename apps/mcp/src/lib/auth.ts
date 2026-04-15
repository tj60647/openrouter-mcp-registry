import { NextRequest, NextResponse } from 'next/server';

export function validateAdminToken(req: NextRequest): NextResponse | null {
  const token = req.headers.get('authorization')?.replace('Bearer ', '').trim();
  const expected = process.env['ADMIN_SECRET'];
  if (!expected) {
    return NextResponse.json({ error: 'Admin auth not configured' }, { status: 503 });
  }
  if (!token || token !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}

export function validateMcpToken(req: NextRequest): NextResponse | null {
  const mcpKey = process.env['MCP_API_KEY'];
  if (!mcpKey) return null; // open if not configured

  const token = req.headers.get('authorization')?.replace('Bearer ', '').trim();
  if (!token || token !== mcpKey) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}
