import { Body, Controller, HttpCode, Post, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleSheetsService } from './google-sheets.service';

@Controller('google-sheets')
export class GoogleSheetsController {
  private readonly defaultSpreadsheetId: string;
  private readonly defaultSheetName: string;

  constructor(
    private readonly sheetsService: GoogleSheetsService,
    private readonly configService: ConfigService,
  ) {
    this.defaultSpreadsheetId = this.configService.get<string>('GOOGLE_SHEETS_SPREADSHEET_ID') ?? '';
    this.defaultSheetName = this.configService.get<string>('GOOGLE_SHEETS_DEFAULT_SHEET') ?? 'Pagos';
  }

  /**
   * POST /google-sheets/append
   * Body: JSON plano con los datos a insertar (campos = nombres de columna)
   * Query params opcionales: spreadsheetId, sheet
   */
  @Post('append')
  @HttpCode(200)
  async append(
    @Body() body: Record<string, string> | string,
    @Query('spreadsheetId') spreadsheetId?: string,
    @Query('sheet') sheet?: string,
  ) {
    const sid = spreadsheetId || this.defaultSpreadsheetId;
    const sheetName = sheet || this.defaultSheetName;

    if (!sid) {
      return { success: false, error: 'spreadsheetId no configurado.' };
    }

    let data: Record<string, string>;
    if (typeof body === 'string') {
      try {
        data = JSON.parse(body);
      } catch {
        return { success: false, error: 'Body inválido: no es JSON válido.' };
      }
    } else {
      data = body;
    }

    return this.sheetsService.appendRow(sid, sheetName, data);
  }
}
