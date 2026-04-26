import { google } from 'googleapis';
import { getAuthClient, getConnectionStatus } from '../../../projects/signet/src/google/oauth.js';

export const schema = {
    name: "create_google_doc",
    description: "Autonomously create a Google Document containing the specified text content. Requires an active Google connection in the Signet platform.",
    parameters: {
        type: "object",
        properties: {
            title: { type: "string", description: "The title of the document" },
            content: { type: "string", description: "The plain text content to insert into the document" },
            userId: { type: "number", description: "The Signet user ID to execute this on behalf of. Defaults to 1 (Admin/Owner)." }
        },
        required: ["title", "content"]
    }
};

export async function execute(args) {
    const userId = args.userId || 1;
    const status = getConnectionStatus(userId);
    
    if (!status.connected) {
        return { error: `User ID ${userId} does not have an active Google connection in Signet.` };
    }

    try {
        const auth = await getAuthClient(userId);
        const docs = google.docs({ version: 'v1', auth });

        // 1. Create the blank document
        const createRes = await docs.documents.create({
            requestBody: { title: args.title }
        });
        
        const documentId = createRes.data.documentId;

        // 2. Insert the text content at the beginning (index 1)
        if (args.content && args.content.trim()) {
            await docs.documents.batchUpdate({
                documentId,
                requestBody: {
                    requests: [
                        {
                            insertText: {
                                location: { index: 1 },
                                text: args.content
                            }
                        }
                    ]
                }
            });
        }

        return { 
            success: true, 
            documentId: documentId,
            url: `https://docs.google.com/document/d/${documentId}/edit` 
        };
    } catch (err) {
        console.error(`[Google Docs Tool Failed]`, err);
        return { error: `Failed to create document: ${err.message}` };
    }
}
