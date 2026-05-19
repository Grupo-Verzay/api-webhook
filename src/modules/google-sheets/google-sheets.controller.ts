import { Body, Controller, Headers, HttpCode, Post, Query, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleSheetsService } from './google-sheets.service';

@Controller('google-sheets')
export class GoogleSheetsController {
  constructor(
    private readonly sheetsService: GoogleSheetsService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * POST /google-sheets/append
   * Headers: x-internal-secret o Authorization: Bearer <CRM_FOLLOW_UP_RUNNER_KEY>
   * Query params requeridos: spreadsheetId, sheet
   * Body: JSON plano con los datos a insertar (campos = nombres de columna)
   */
  @Post('append')
  @HttpCode(200)
  async append(
    @Headers() headers: Record<string, string>,
    @Body() body: Record<string, string> | string,
    @Query('spreadsheetId') spreadsheetId?: string,
    @Query('sheet') sheet?: string,
  ) {
    const key = (this.configService.get<string>('CRM_FOLLOW_UP_RUNNER_KEY') ?? '').trim();
    const provided = (headers['x-internal-secret'] ?? headers['authorization']?.replace('Bearer ', '') ?? '').trim();
    if (!key || provided !== key) throw new UnauthorizedException();

    if (!spreadsheetId) {
      return { success: false, error: 'El parámetro spreadsheetId es requerido.' };
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

    return this.sheetsService.appendRow(spreadsheetId, sheet, data);
  }
}
