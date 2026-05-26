import {
  protectedResourceHandler,
  metadataCorsOptionsRequestHandler,
} from 'mcp-handler';
import { getIssuerUrl } from '../../../lib/oauth';

/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728).
 * Points MCP clients to our Authorization Server for token acquisition.
 */
const handler = protectedResourceHandler({
  authServerUrls: [getIssuerUrl()],
});

const corsHandler = metadataCorsOptionsRequestHandler();

export { handler as GET, corsHandler as OPTIONS };
