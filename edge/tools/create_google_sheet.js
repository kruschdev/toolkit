import { google } from 'googleapis';
import { getAuthClient, getConnectionStatus } from '../../../projects/signet/src/google/oauth.js';

export const schema = {
    name: "create_google_sheet",
    description: "Autonomously create a Google Spreadsheet populated with initial data. Requires an active Google connection in the Signet platform.",
    parameters: {
        type: "object",
        properties: {
            title: { type: "string", description: "The title of the spreadsheet" },
            data: { type: "array", items: { type: "array", items: { type: "string" } }, description: "A 2D array of rows and columns representing the spreadsheet data (e.g., [['Name', 'Age'], ['Alice', '30']])" },
            userId: { type: "number", description: "The Signet user ID to execute this on behalf of. Defaults to 1 (Admin/Owner)." }
        },
        required: ["title", "data"]
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
        const sheets = google.sheets({ version: 'v4', auth });

        // 1. Create the blank spreadsheet
        const createRes = await sheets.spreadsheets.create({
            requestBody: { properties: { title: args.title } }
        });
        
        const spreadsheetId = createRes.data.spreadsheetId;

        // 2. Insert the 2D array data into the first sheet (Sheet1)
        if (args.data && Array.isArray(args.data) && args.data.length > 0) {
            await sheets.spreadsheets.values.update({
                spreadsheetId,
                range: 'Sheet1!A1',
                valueInputOption: 'USER_ENTERED',
                requestBody: { values: args.data }
            });
        }

        return { 
            success: true, 
            spreadsheetId: spreadsheetId,
            url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit` 
        };
    } catch (err) {
        console.error(`[Google Sheets Tool Failed]`, err);
        return { error: `Failed to create spreadsheet: ${err.message}` };
    }
}
