// Importa las dependencias necesarias
import { DynamoDBClient, PutItemCommand, ScanCommand, GetItemCommand, DeleteItemCommand } from "@aws-sdk/client-dynamodb";
import { decrypt_object_id } from '/opt/aes256.mjs';
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { unmarshall } from "@aws-sdk/util-dynamodb"; // Utilidad para convertir los datos

 
// Creamos el cliente S3
const s3 = new S3Client({ region: 'us-east-1' });
// Crea un cliente de DynamoDB
const dynamoDBClient = new DynamoDBClient({ region: 'us-east-1' });


// Función Lambda handler
export const handler = async (event) => {

 let port_set = 0;

 let emailEncrypt = event.queryStringParameters?.email;  // Conversión a string
 
 let email_bk = event.queryStringParameters?.email_bk;  // Conversión a string
 
 let pm2 = event.queryStringParameters?.pm2;  // Conversión a string
 
  console.log("queryStringParameters:",event.queryStringParameters)
 
 let email = "";
 if(!emailEncrypt){
   email = email_bk;
 }else{
    email = decrypt_object_id(emailEncrypt);
 }

  if (!email) {
    return {
       headers: {
            "Access-Control-Allow-Origin": "*", // Or specify your domain
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Allow-Methods": "POST"
        },
      statusCode: 400,
      body: JSON.stringify({ message: 'email is a required query parameter' })
    };
  }
  
  const { credit,port,api,template = 'chat-bot-whatsapp' } =  JSON.parse(event.body);


  
  
  const numericCredit = Number(credit);
  const safeCredit = Number.isFinite(numericCredit) ? numericCredit : 0;
  let free_try = safeCredit === 1;

  console.log("request: ",{ email, credit: safeCredit, port, free_try })
    
 let table_whatsapp_setting = "whatsapp_setting";
 let table_whatsapp_prompt = "whatsapp_prompt";
 let table_whatsapp_alarm = "whatsapp_alarm";
 let table_whatsapp_status = "whatsapp_status";
 let table_whatsapp_message = "whatsapp_message";
 let table_whatsapp_whitelist = "whatsapp_whitelist";
 let table_whatsapp_free_try = "whatsapp_free_try";
 let table_whatsapp_premiun = "whatsapp_premiun";

  const field_prompt = await getTemplateFromS3();
  
  const params_prompt = {
    TableName: table_whatsapp_prompt,
    Item: {
      email: { S: email },
      prompt: { S: field_prompt.prompt.S },
      name: { S: field_prompt.name.S },
      description: { S: field_prompt.description.S },
      products: { S: field_prompt.products.S },
      format_order: { S: field_prompt.format_order.S },
      instruccions_iteration: { S: field_prompt.instruccions_iteration.S },
      goal: { S: field_prompt.goal.S },
      s3_url_menu: { S: field_prompt.s3_url_menu.S },
      how_responding_customer: { S: field_prompt.how_responding_customer.S },
      welcome: { S: field_prompt.welcome.S },
      tono: { S: field_prompt.tono.S },
      timestamp: { S: new Date().toISOString() }
    }
  };
  
      console.log("table_whatsapp_prompt : ",table_whatsapp_prompt)

  
    const params_alarm = {
    TableName: table_whatsapp_alarm,
    Item: {
      email: { S: email },
      list_email: { S: email },
      list_phone: { S: "" },
      regex: { M: {} },
      status_email: { BOOL: true },
      status_phone: { BOOL: false },
      timestamp: { S: new Date().toISOString() }
    }
  };
  
        console.log("params_alarm : ",params_alarm)


  const params_status = {
    TableName: table_whatsapp_status,
    Item: {
      email: { S: email },
      start_time: { S: "09:00:00" },
      end_time: { S: "21:00:00" },
      status: { BOOL: true },
      status_schedule: { BOOL: false },
      timezone: { S: "" }
    }
  };
  
          console.log("params_status : ",params_status)

  
  const userName = getNameUser(email)

  const params_message = {
    TableName: table_whatsapp_message,
    Item: {
      email: { S: email },
      url_history_message: { S: "http://44.194.126.224/clientes_chatbot/cliente_"+userName+"/sessions_history/" },
      url_message: { S: "http://44.194.126.224/clientes_chatbot/cliente_"+userName+"/bot_sessions/baileys_store.json" },
      url_qr: { S: "http://44.194.126.224/clientes_chatbot/cliente_"+userName+"/bot.qr.png" },
      url_qr_sending: { S: "" },
      timestamp: { S: new Date().toISOString() }
    }
  };
  
            console.log("params_message : ",params_message)

  
  const params_whitelist = {
    TableName: table_whatsapp_whitelist,
    Item: {
      email: { S: email },
      whitelist: { S: "" }
    }
  };
  
              console.log("params_message : ",params_whitelist)
              
              
              
              
  const params_free_try = {
    TableName: table_whatsapp_free_try,
    Item: {
      email: { S: email },
      finish_free_try: { S: getTodayDate() },
    }
  };
  
          console.log("params_free_try : ",params_free_try)
          
const datePeriodPremiun = new Date();
const finishPeriodDays = free_try ? 2 : 30;
const finish_period = new Date(datePeriodPremiun.getTime() + finishPeriodDays * 24 * 60 * 60 * 1000);
          
const params_whatsapp_premiun = {
    TableName: table_whatsapp_premiun,
    Item: {
      email: { S: email },
      plan: { S: "Enterprise" },
      finish_period: { S: finish_period.toISOString() }
    }
  };
  
    console.log("params_whatsapp_premiun : ",params_whatsapp_premiun)



  try {
    const getSetting = await getItemFromDynamoDB(table_whatsapp_setting,email);

    if(port !== undefined && port !== null && String(port).trim() !== ""){
      port_set = String(port);
    }else if (getSetting?.port) {
      port_set = String(getSetting.port);
    }else{
      port_set = await getMaxPortPm2Instance();
      port_set = String(port_set);
    }

    let pm2status = (pm2 || free_try) ? "Activo":"Apagada";

    const params = {
      TableName: table_whatsapp_setting,
      Item: {
        email: { S: email },
        credit: { N: String(safeCredit + 20) },
        port: { S: port_set },
        template: { S: template },
        status_pm2: { S: pm2status },
        timestamp: { S: new Date().toISOString() }
      }
    };

    console.log("resolved_port :", { email, bodyPort: port, settingPort: getSetting?.port, port_set });
    console.log("params : ",params)

    // Ejecuta la operación PutItem en DynamoDB
    if(!getSetting){
      const command = new PutItemCommand(params);
      await dynamoDBClient.send(command);
    }else{
      let total = free_try ? 20 : safeCredit;
      let pm2status = (pm2 || free_try) ? "Activo":"Apagada";
      console.log("pm2 || free_try:",{pm2,free_try})
      console.log("pm2status:",pm2status)
      const params = {
        TableName: table_whatsapp_setting,
        Item: {
          email: { S: email },
          credit: { N: String(total) },
            port: { S: port_set },
          status_pm2: { S: pm2status },
          timestamp: { S: new Date().toISOString() }
        }
      };
          console.log("params_whatsapp_setting update : ",params)
      const command = new PutItemCommand(params);
      await dynamoDBClient.send(command);
          console.log("paso params free_try")
      if(total > 20 || pm2status === "Apagada"){
        await dynamoDBClient.send(new DeleteItemCommand({
          TableName: "whatsapp_free_try",
          Key: {
            email: { S: email }
          }
        }));
      }

    }
    
    
    // Ejecuta la operación PutItem en DynamoDB
    const getPrompt = await getItemFromDynamoDB(params_prompt.TableName,email);
    console.log("paso params_prompt")
    if(!getPrompt){
      const command_params_prompt = new PutItemCommand(params_prompt);
      await dynamoDBClient.send(command_params_prompt);
    }
    
    
    
    // Ejecuta la operación PutItem en DynamoDB
    const getStatus = await getItemFromDynamoDB(params_status.TableName,email);
        console.log("paso params_status")
    if(!getStatus){
      const command_params_status = new PutItemCommand(params_status);
      await dynamoDBClient.send(command_params_status);
    }
    
    
    // Ejecuta la operación PutItem en DynamoDB
    const getAlarm = await getItemFromDynamoDB(params_alarm.TableName,email);
        console.log("paso params_alarm")
    if(!getAlarm){
      const command_params_alarm = new PutItemCommand(params_alarm);
      await dynamoDBClient.send(command_params_alarm);
    }
    
    // Ejecuta la operación PutItem en DynamoDB
    const getMessage = await getItemFromDynamoDB(params_message.TableName,email);
            console.log("paso params_message")
    if(!getMessage){
      const command_params_message = new PutItemCommand(params_message);
      await dynamoDBClient.send(command_params_message);
    }
    
     // Ejecuta la operación PutItem en DynamoDB
    const getWhitelist = await getItemFromDynamoDB(params_whitelist.TableName,email);
                console.log("paso params_whitelist")
    if(!getWhitelist){
      const command_params_whitelist = new PutItemCommand(params_whitelist);
      await dynamoDBClient.send(command_params_whitelist);
    }
    
    // Ejecuta la operación PutItem en DynamoDB
    if(free_try){
      const getFreeTry = await getItemFromDynamoDB(params_free_try.TableName,email);
                      console.log("paso params_free_try")
      if(!getFreeTry){
        const command_params_free_try = new PutItemCommand(params_free_try);
        await dynamoDBClient.send(command_params_free_try);
      }
    }
    
    // Ejecuta la operación PutItem en DynamoDB
  
    const getPremiun = await getItemFromDynamoDB(params_whatsapp_premiun.TableName,email);
                          console.log("paso params_whatsapp_premiun", { email, free_try, finishPeriodDays, hasPremiun: !!getPremiun })
    const command_params_whatsapp_premiun = new PutItemCommand(params_whatsapp_premiun);
    await dynamoDBClient.send(command_params_whatsapp_premiun);
    
    
    if(pm2 && !api || free_try && !api){
                                console.log("paso createPM2Instance")
      await createPM2Instance(email,userName,port_set,template);
    }
    
    return {
      headers: {
            "Access-Control-Allow-Origin": "*", // Or specify your domain
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Allow-Methods": "POST"
        },
      statusCode: 200,
      body: JSON.stringify({ message: 'Item successfully added to DynamoDB' })
    };
  } catch (error) {
    console.error('Error putting item into DynamoDB', error);
    return {
      headers: {
            "Access-Control-Allow-Origin": "*", // Or specify your domain
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Allow-Methods": "POST"
        },
      statusCode: 500,
      body: JSON.stringify({ message: 'Error putting item into DynamoDB', error: error.message })
    };
  }
};


function getTodayDate() {
    let date = new Date();
    
    // Sumar 2 días
    date.setDate(date.getDate() + 2);

    // Obtener los componentes de la fecha
    let year = date.getFullYear();
    let month = String(date.getMonth() + 1).padStart(2, '0'); // Meses son base 0
    let day = String(date.getDate()).padStart(2, '0');

    return `${year}-${month}-${day}`;
}

function getNameUser(email) {
    let part = email.split('@');
    if (part.length > 1) {
        // Reemplaza todos los puntos en la parte del nombre de usuario
        let username = part[0].replace(/\./g, '');
        return username;
    } else {
        throw new Error('El formato del correo no es válido.');
    }
}



async function getTemplateFromS3(){
     // Configura el bucket y el nombre del archivo que deseas leer
    const bucketName = 'templateemail';
    const key = 'PROMPT_BASE.json'; // Ruta del archivo HTML dentro del bucket

    const params = {
        Bucket: bucketName,
        Key: key
    };

    try {
        // Lee el archivo desde S3 usando el nuevo cliente y comando
        const command = new GetObjectCommand(params);
        const data = await s3.send(command);

        // El contenido del archivo está en el stream de `Body`, lo convertimos a texto
        const stream = data.Body;
        const htmlContent = await streamToString(stream); // Convertir stream a string

        // Opcional: haz algo con el contenido, como devolverlo o procesarlo
        return JSON.parse(htmlContent)
    } catch (err) {
        console.error("Error al obtener el archivo de S3:", err);
        return null;
    }
}

const streamToString = (stream) => {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        stream.on('error', reject);
    });
};

async function createPM2Instance(email,userName,port,template){
  
  const raw = JSON.stringify({
    id: userName,
    name: userName,
    email: email,
    port: port,
    template: template
  });
  
  const apiUrl = "http://44.194.126.224:4000/clientes/create"; // Reemplaza con la URL de tu API
  const requestOptions = {
      method: "POST",
      headers: {
        "Content-Type": "application/json", // Asegura que el contenido sea JSON
      },
      body: raw
    };
  
  try {
    const response = await global.fetch(apiUrl, requestOptions);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    console.log("Success:", data);
    await notificationAddCredit(email)
  } catch (error) {
    console.error("Error:", error);
  }

}


async function getMaxPortPm2Instance(){
   try {
    const params = {
      TableName: 'whatsapp_setting',
      ProjectionExpression: 'port',
    };

    const command = new ScanCommand(params);
    const data = await dynamoDBClient.send(command);

    // Suponiendo que los valores de 'port' son strings que pueden ser convertidos a números para comparar
    const ports = data.Items
      .filter(item => item.port && item.port.S)
      .map(item => parseInt(item.port.S, 10));
      
    let maxPort = Math.max(...ports);

    return (maxPort+1);
  } catch (error) {
    console.log("Error getMaxPortPm2Instance: ",error)
    return null
  }
}


async function getItemFromDynamoDB(tableName, email) {
  const params = {
    TableName: tableName,
    Key: {
      email: { S: email }
    }
  };

  try {
    const command = new GetItemCommand(params);
    const data = await dynamoDBClient.send(command);
    
    if (!data.Item) {
      return null;
    }

    const result = unmarshall(data.Item);
    return result;
  } catch (error) {
    console.error("getItemFromDynamoDB: ",error);
    return null;
  }
}

async function replaceTemplateWithData(template, variables) {
    return template.replace(/{(.*?)}/g, (match, key) => {
        // Retorna el valor correspondiente de las variables o el match original si no encuentra el valor
        return variables[key] || match;
    });
}


async function notificationAddCredit(email){
  
  const variables = {
        name: email
    };
  
  try{
          const s3Html = await getTemplateFromS3Credit();
          const HTMLBody = await replaceTemplateWithData(s3Html,variables)
          const response_email = await sendMailjetRequest(email,HTMLBody);
          
        console.log("email enviado",response_email)

      } catch (error) {
        console.error("Error email enviado",error)
      }
      
}




// Función que envía la solicitud a Mailjet usando fetch
async function sendMailjetRequest(email_send,HTMLBody) {
    const emailUrl = "https://api.mailjet.com/v3.1/send";
    const mailjetKey = "8510f9d132fdd92df7c341f51d282dd8:c4997e20d75626f02ab545a2efa6515a";
    const emailFrom = "admin@telknec.cl";
    const emailTo = email_send;

    // Utiliza la función `bodyMailJet` de tu utilidad
    const body = bodyMailJet(
        emailFrom,
        emailTo,
        "Chat Bot Whatsapp Activo",
        "Chat Bot Whatsapp Activo",
        HTMLBody
    );

    try {
        const response = await global.fetch(emailUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Basic ' + Buffer.from(mailjetKey).toString('base64') // Codificar en base64 el USERPWD
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const errorDetails = await response.text(); // O response.json() si esperas un JSON
            throw new Error(`Error en la solicitud email: ${errorDetails}`);
        }

        const result = await response.json();
        console.log("Response data email:", result);
        return result;

    } catch (error) {
        console.error("Error al enviar la solicitud a Mailjet:", error);
        throw new Error(`Try Error en la solicitud email: ${error}`);
    }
}

function bodyMailJet(from, to, senderName, subject, body) {
    return {
        Messages: [
            {
                From: {
                    Email: from,
                    Name: senderName
                },
                To: [
                    {
                        Email: to,
                        Name: senderName
                    }
                ],
                Subject: subject,
                HTMLPart: body
            }
        ]
    };
}


async function getTemplateFromS3Credit(){
     // Configura el bucket y el nombre del archivo que deseas leer
    const bucketName = 'templateemail';
    const key = 'credits.html'; // Ruta del archivo HTML dentro del bucket

    const params = {
        Bucket: bucketName,
        Key: key
    };

    try {
        // Lee el archivo desde S3 usando el nuevo cliente y comando
        const command = new GetObjectCommand(params);
        const data = await s3.send(command);

        // El contenido del archivo está en el stream de `Body`, lo convertimos a texto
        const stream = data.Body;
        const htmlContent = await streamToString(stream); // Convertir stream a string

        // Opcional: haz algo con el contenido, como devolverlo o procesarlo
        return htmlContent
    } catch (err) {
        console.error("Error al obtener el archivo de S3:", err);
        return null;
    }
}
