// ecosystem.config.js  
module.exports = {  
  apps: [{  
    name: 'api-webhookCluster',  
    script: 'dist/main.js',  
    instances: 10, 
    exec_mode: 'cluster',  
    max_memory_restart: '1G',  
    env: {  
      NODE_ENV: 'production',  
      PORT: 5001  // UN SOLO PUERTO  
    }  
  }]  
};