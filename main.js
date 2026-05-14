// importa os bibliotecas necessários
const serialport = require('serialport');
const express = require('express');
const mysql = require('mysql2');

// constantes para configurações
const SERIAL_BAUD_RATE = 9600;
const SERVIDOR_PORTA = 3300;
const SENSOR_ID = 1;

// habilita ou desabilita a inserção de dados no banco de dados
const HABILITAR_OPERACAO_INSERIR = true;

// função para comunicação serial
const serial = async (
  valoresSensorAnalogico,
  valoresSensorDigital,
) => {

  // conexão com o banco de dados MySQL
  let poolBancoDados = mysql.createPool(
    {
      host: 'localhost',
      user: 'dat_acqu_ino_api',
      password: 'Sptech#2024',
      database: 'composteco',
      port: 3307
    }
  ).promise();

  // lista as portas seriais disponíveis e procura pelo Arduino
  const portas = await serialport.SerialPort.list();
  const portaArduino = portas.find((porta) => porta.vendorId == 2341 && porta.productId == 43);
  if (!portaArduino) {
    throw new Error('O arduino não foi encontrado em nenhuma porta serial');
  }

  // configura a porta serial com o baud rate especificado
  const arduino = new serialport.SerialPort(
    {
      path: portaArduino.path,
      baudRate: SERIAL_BAUD_RATE
    }
  );

  // evento quando a porta serial é aberta
  arduino.on('open', () => {
    console.log(`A leitura do arduino foi iniciada na porta ${portaArduino.path} utilizando Baud Rate de ${SERIAL_BAUD_RATE}`);
  });

  // processa os dados recebidos do Arduino
  arduino.pipe(new serialport.ReadlineParser({ delimiter: '\r\n' })).on('data', async (data) => {
    console.log(data);
    const valores = data.split(';');
    const sensorDigital = parseInt(valores[0]);
    const sensorAnalogico = parseFloat(valores[1]);

    // armazena os valores dos sensores nos arrays correspondentes
    valoresSensorAnalogico.push(sensorAnalogico);
    valoresSensorDigital.push(sensorDigital);

    // insere os dados no banco de dados (se habilitado)
    if (HABILITAR_OPERACAO_INSERIR) {

      // este insert irá inserir os dados na tabela "medida"
      await poolBancoDados.execute(
        'INSERT INTO deteccao (sensor_id, temperatura, umidade) VALUES (?, ?, ?)',
        [SENSOR_ID, sensorAnalogico, sensorDigital]
      );
      console.log("valores inseridos no banco: ", sensorAnalogico + ", " + sensorDigital);

    }

    inserirAlerta(valoresSensorAnalogico, valoresSensorDigital)

  });

  // evento para lidar com erros na comunicação serial
  arduino.on('error', (mensagem) => {
    console.error(`Erro no arduino (Mensagem: ${mensagem}`)
  });
}

// função em que faz toda a funcionalidade de inserção de alertas no banco
const inserirAlerta = async (valoresSensorAnalogico, valoresSensorDigital) => {
  let poolBancoDados = await mysql.createPool(
    {
      host: 'localhost',
      user: 'dat_acqu_ino_api',
      password: 'Sptech#2024',
      database: 'composteco',
      port: 3307
    }
  ).promise();

  let resposta = false

  // const delay = 5 // em segundos
  const qntDeteccoesMinuto = 6 // quantidade de detecções por minuto

  // apenas dar continuidade à função a cada período de tempo
  if (valoresSensorAnalogico.length % qntDeteccoesMinuto != 0)
    return resposta


  // Média das detecções nesse periodo tempo
  let j = 0
  const temperaturasUltimaHora = []
  for (let i = valoresSensorAnalogico.length - qntDeteccoesMinuto; i < valoresSensorAnalogico.length; i++) {
    temperaturasUltimaHora[j] = valoresSensorAnalogico[i]
    j++
  }
  const mediaTemperaturaUltimaHora = (temperaturasUltimaHora.reduce((soma, temperatura) => soma + temperatura, 0)) / qntDeteccoesMinuto

  j = 0
  const umidadesUltimaHora = []
  for (let i = valoresSensorDigital.length - qntDeteccoesMinuto; i < valoresSensorDigital.length; i++) {
    umidadesUltimaHora[j] = valoresSensorDigital[i]
    j++
  }
  const mediaUmidadeUltimaHora = (umidadesUltimaHora.reduce((soma, umidade) => soma + umidade, 0)) / qntDeteccoesMinuto

  // coleta o tipo/classificação do alerta, dada a temperatura e umidade média
  const tipoAlerta = gerarTipoAlerta(mediaTemperaturaUltimaHora, mediaUmidadeUltimaHora)
  // condicional para não inserir alerta, caso as condições estejam ideais
  if (!tipoAlerta)
    return resposta

  const qntAlertasSeisHorasRetorno = await poolBancoDados.execute(
    'SELECT COUNT(*) qnt FROM alerta a JOIN deteccao d ON a.deteccao_id = d.id WHERE d.sensor_id = ? AND a.enviado_em >= DATE_SUB(current_timestamp(), INTERVAL 4 MINUTE)',
    [SENSOR_ID]
  )
  const qntAlertasSeisHoras = qntAlertasSeisHorasRetorno[0][0].qnt // coletar quantidade de alertas em determinado período

  const deteccaoIdRetorno = await poolBancoDados.execute(
    'SELECT id FROM deteccao WHERE sensor_id = ? ORDER BY criado_em DESC LIMIT 1',
    [SENSOR_ID]
  )
  const deteccaoId = deteccaoIdRetorno[0][0].id // coleta id da última detecção para fazer a relação

  const qntLinhasInseridas = await poolBancoDados.execute(
    'INSERT INTO alerta (deteccao_id, tipo, prioridade) VALUES (?, ?, ?)',
    [deteccaoId, tipoAlerta, Math.floor(qntAlertasSeisHoras / 2)]
  )

  return qntLinhasInseridas[0].affectedRows > 0 // retorna true, se o alerta foi inserido no bando, caso contrário, retorna false
}

const gerarTipoAlerta = (temperatura, umidade) => {
  if (umidade < 70 && temperatura < 20)
    return 'baixa umidade e temperatura'
  if (umidade > 85 && temperatura > 25)
    return 'alta umidade e temperatura'
  if (umidade > 85 && temperatura < 20)
    return 'alta umidade e baixa temperatura'
  if (umidade < 70 && temperatura > 25)
    return 'baixa umidade e alta temperatura'
  if (umidade < 70)
    return 'baixa umidade'
  if (umidade > 85)
    return 'alta umidade'
  if (temperatura < 20)
    return 'baixa temperatura'
  if (temperatura > 25)
    return 'alta temperatura'

  return false
}

// função para criar e configurar o servidor web
const servidor = (
  valoresSensorAnalogico,
  valoresSensorDigital
) => {
  const app = express();

  // configurações de requisição e resposta
  app.use((request, response, next) => {
    response.header('Access-Control-Allow-Origin', '*');
    response.header('Access-Control-Allow-Headers', 'Origin, Content-Type, Accept');
    next();
  });

  // inicia o servidor na porta especificada
  app.listen(SERVIDOR_PORTA, () => {
    console.log(`API executada com sucesso na porta ${SERVIDOR_PORTA}`);
  });

  // define os endpoints da API para cada tipo de sensor
  app.get('/sensores/analogico', (_, response) => {
    return response.json(valoresSensorAnalogico);
  });
  app.get('/sensores/digital', (_, response) => {
    return response.json(valoresSensorDigital);
  });
}

// função principal assíncrona para iniciar a comunicação serial e o servidor web
(async () => {
  // arrays para armazenar os valores dos sensores
  const valoresSensorAnalogico = [];
  const valoresSensorDigital = [];

  // inicia a comunicação serial
  await serial(
    valoresSensorAnalogico,
    valoresSensorDigital
  );

  // inicia o servidor web
  servidor(
    valoresSensorAnalogico,
    valoresSensorDigital
  );
})();
