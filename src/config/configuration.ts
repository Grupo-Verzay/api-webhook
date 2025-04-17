export default () => ({
    // App
    port: process.env.PORT || 3000,
    nodeEnv: process.env.NODE_ENV || 'development',

    // Auth
    authSecret: process.env.AUTH_SECRET,
    authResendKey: process.env.AUTH_RESEND_KEY,
    nextAuthUrl: process.env.NEXTAUTH_URL,

    // Google Auth
    authGoogleId: process.env.AUTH_GOOGLE_ID,
    authGoogleSecret: process.env.AUTH_GOOGLE_SECRET,

    // Github Auth
    authGithubId: process.env.AUTH_GITHUB_ID,
    authGithubSecret: process.env.AUTH_GITHUB_SECRET,

    // Database
    databaseUrl: process.env.DATABASE_URL,

    // S3 Storage
    s3: {
        accessKey: process.env.S3_ACCESS_KEY,
        secretKey: process.env.S3_SECRET_KEY,
        endpoint: process.env.S3_ENDPOINT,
        publicUrl: process.env.S3_PUBLIC_URL,
        bucketName: process.env.S3_BUCKET_NAME,
    },
});
