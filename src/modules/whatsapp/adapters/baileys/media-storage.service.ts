import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

@Injectable()
export class MediaStorageService {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicUrl: string;

  constructor(private readonly config: ConfigService) {
    const endpoint = config.get<string>('s3.endpoint') ?? '';
    const accessKeyId = config.get<string>('s3.accessKey') ?? '';
    const secretAccessKey = config.get<string>('s3.secretKey') ?? '';
    this.bucket = config.get<string>('s3.bucketName') ?? '';
    this.publicUrl = (config.get<string>('s3.publicUrl') ?? '').replace(/\/$/, '');

    const endpointUrl = endpoint.startsWith('http') ? endpoint : `https://${endpoint}`;

    this.client = new S3Client({
      endpoint: endpointUrl,
      region: 'us-east-1',
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: true,
    });
  }

  async uploadBuffer(
    buffer: Buffer,
    key: string,
    contentType: string,
  ): Promise<string> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
        ACL: 'public-read' as any,
      }),
    );
    return `${this.publicUrl}/${this.bucket}/${key}`;
  }
}
