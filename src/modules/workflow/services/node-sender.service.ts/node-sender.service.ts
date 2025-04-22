import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class NodeSenderService {
  constructor(private readonly http: HttpService) {}

  async sendTextNode(url: string, apikey: string, remoteJid: string, text: string) {
    const body = {
      number: remoteJid,
      options: { delay: 100, presence: "composing" },
      text,
    };
    await firstValueFrom(this.http.post(url, body, { headers: { 'Content-Type': 'application/json', apikey } }));
  }

  async sendMediaNode(url: string, apikey: string, remoteJid: string, type: string, caption: string, mediaUrl: string) {
    const body = {
      number: remoteJid,
      mediatype: type,
      mimetype: type,
      caption,
      media: mediaUrl,
    };
    await firstValueFrom(this.http.post(url, body, { headers: { 'Content-Type': 'application/json', apikey } }));
  }
}
