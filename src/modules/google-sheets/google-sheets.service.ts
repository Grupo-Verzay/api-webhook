import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { google, sheets_v4 } from 'googleapis';
import { LoggerService } from 'src/core/logger/logger.service';

@Injectable()
export class GoogleSheetsService implements OnModuleInit {
  private sheets: sheets_v4.Sheets;

  constructor(
    private readonly configService: ConfigService,
    private readonly logger: LoggerService,
  ) {}

  onModuleInit() {
    const credentialsRaw = this.configService.get<string>('GOOGLE_SHEETS_CREDENTIALS');
    if (!credentialsRaw) {
      this.logger.warn('[GoogleSheets] GOOGLE_SHEETS_CREDENTIALS no configurado.', 'GoogleSheetsService');
      return;
    }

    const credentials = JSON.parse(credentialsRaw);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    this.sheets = google.sheets({ version: 'v4', auth });
  }

  async appendRow(
    spreadsheetId: string,
    sheetName: string,
    data: Record<string, string>,
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.sheets) {
      return { success: false, error: 'Google Sheets no inicializado. Revisa GOOGLE_SHEETS_CREDENTIALS.' };
    }

    try {
      // 1. Leer encabezados de la fila 1
      const headersRes = await this.sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!1:1`,
      });

      const headers: string[] = headersRes.data.values?.[0] ?? [];
      if (!headers.length) {
        return { success: false, error: `No se encontraron encabezados en la hoja "${sheetName}".` };
      }

      // Normalizar claves del payload a mayúsculas para matching insensible a mayúsculas
      const normalizedData: Record<string, string> = {};
      for (const [k, v] of Object.entries(data)) {
        normalizedData[k.toUpperCase()] = v;
      }

      // 2. Mapear datos a columnas según encabezado
      const row = headers.map((h) => {
        if (h === 'FECHA_REGISTRO') {
          return new Date().toLocaleString('es-CR', { timeZone: 'America/Costa_Rica' });
        }
        const val = normalizedData[h.toUpperCase()];
        return val !== undefined && val !== null && val !== '' ? String(val) : 'N/C';
      });

      // 3. Agregar fila
      await this.sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${sheetName}!A:A`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [row] },
      });

      this.logger.log(
        `[GoogleSheets] Fila agregada en "${sheetName}": ${JSON.stringify(data)}`,
        'GoogleSheetsService',
      );

      return { success: true };
    } catch (err: unknown) {
      const msg = (err as any)?.message ?? String(err);
      this.logger.error(`[GoogleSheets] Error al agregar fila: ${msg}`, 'GoogleSheetsService');
      return { success: false, error: msg };
    }
  }

  async updateRow(
    spreadsheetId: string,
    sheetName: string,
    searchField: string,
    searchValue: string,
    updates: Record<string, string>,
  ): Promise<{ success: boolean; updatedRow?: number; error?: string }> {
    if (!this.sheets) {
      return { success: false, error: 'Google Sheets no inicializado. Revisa GOOGLE_SHEETS_CREDENTIALS.' };
    }

    try {
      // 1. Leer encabezados
      const headersRes = await this.sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!1:1`,
      });
      const headers: string[] = headersRes.data.values?.[0] ?? [];
      if (!headers.length) {
        return { success: false, error: `No se encontraron encabezados en la hoja "${sheetName}".` };
      }

      const headersUpper = headers.map((h) => h.toUpperCase());
      const searchColIdx = headersUpper.indexOf(searchField.toUpperCase());
      if (searchColIdx === -1) {
        return { success: false, error: `Columna "${searchField}" no encontrada en la hoja.` };
      }

      // 2. Leer todas las filas para encontrar la que coincide
      const dataRes = await this.sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!A:Z`,
      });
      const rows: string[][] = dataRes.data.values ?? [];

      const rowIdx = rows.findIndex(
        (row, i) => i > 0 && (row[searchColIdx] ?? '').toString().trim().toLowerCase() === searchValue.trim().toLowerCase(),
      );

      if (rowIdx === -1) {
        return { success: false, error: `No se encontró ninguna fila donde ${searchField} = "${searchValue}".` };
      }

      // 3. Construir actualizaciones por celda
      const sheetRowNumber = rowIdx + 1; // 1-indexed
      const requests: Promise<any>[] = [];

      for (const [field, value] of Object.entries(updates)) {
        const colIdx = headersUpper.indexOf(field.toUpperCase());
        if (colIdx === -1) continue;
        const colLetter = String.fromCharCode(65 + colIdx);
        requests.push(
          this.sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `${sheetName}!${colLetter}${sheetRowNumber}`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [[value]] },
          }),
        );
      }

      if (!requests.length) {
        return { success: false, error: 'Ningún campo de actualización coincide con los encabezados de la hoja.' };
      }

      await Promise.all(requests);

      this.logger.log(
        `[GoogleSheets] Fila ${sheetRowNumber} actualizada en "${sheetName}": ${JSON.stringify(updates)}`,
        'GoogleSheetsService',
      );

      return { success: true, updatedRow: sheetRowNumber };
    } catch (err: unknown) {
      const msg = (err as any)?.message ?? String(err);
      this.logger.error(`[GoogleSheets] Error al actualizar fila: ${msg}`, 'GoogleSheetsService');
      return { success: false, error: msg };
    }
  }
}
