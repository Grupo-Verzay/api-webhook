import { Body, Controller, HttpCode, Post, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleSheetsService } from './google-sheets.service';

@Controller('google-sheets')
export class GoogleSheetsController {
  private readonly defaultSpreadsheetId: string;

  constructor(
    private readonly sheetsService: GoogleSheetsService,
    private readonly configService: ConfigService,
  ) {
    this.defaultSpreadsheetId = this.configService.get<string>('GOOGLE_SHEETS_SPREADSHEET_ID') ?? '';
  }

  /**
   * POST /google-sheets/append
   * Body: JSON plano con los datos a insertar (campos = nombres de columna)
   * Query params requeridos: sheet
   * Query params opcionales: spreadsheetId
   */
  @Post('append')
  @HttpCode(200)
  async append(
    @Body() body: Record<string, string> | string,
    @Query('spreadsheetId') spreadsheetId?: string,
    @Query('sheet') sheet?: string,
  ) {
    const sid = spreadsheetId || this.defaultSpreadsheetId;

    if (!sid) {
      return { success: false, error: 'spreadsheetId no configurado.' };
    }

    if (!sheet) {
      return { success: false, error: 'El parámetro sheet es requerido.' };
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

    return this.sheetsService.appendRow(sid, sheet, data);
  }
}
