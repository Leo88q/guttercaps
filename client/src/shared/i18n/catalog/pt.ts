import type en from './en';
type Catalog = { [K in keyof typeof en]: { [P in keyof (typeof en)[K]]: string } };
const catalog = {
  "c0r0": {
    "name": "Mariposa rápida",
    "desc": "Um esboço de uma camada, ainda molhado nas bordas."
  },
  "c0r1": {
    "name": "Mariposa na segunda chuva",
    "desc": "O mesmo esboço, polido por outra enchente."
  },
  "c0r2": {
    "name": "Mariposa com maleta",
    "desc": "Uma obra em camadas com crítica social afiada."
  },
  "c0r3": {
    "name": "Mariposa com maleta — segunda camada",
    "desc": "Repintada sobre o original apagado."
  },
  "c0r4": {
    "name": "Mariposa atrás das grades",
    "desc": "A obra que o bairro debateu por uma semana."
  },
  "c0r5": {
    "name": "Mariposa atrás das grades — registro",
    "desc": "A mesma cena, agora datada e assinada."
  },
  "c0r6": {
    "name": "A noite das três paredes",
    "desc": "Três obras, três bairros, uma noite."
  },
  "c0r7": {
    "name": "A noite das três paredes — parede quatro",
    "desc": "Um quarto avistamento não confirmado."
  },
  "c0r8": {
    "name": "A carga original",
    "desc": "A primeira tampinha deixada na primeira obra. Só existe uma."
  },
  "c1r0": {
    "name": "Primeira descida",
    "desc": "A primeira entrada na pista em forma de piscina."
  },
  "c1r1": {
    "name": "Segunda tentativa",
    "desc": "A mesma descida, concluída na segunda tentativa."
  },
  "c1r2": {
    "name": "Grind às cegas",
    "desc": "Um grind sem olhar para baixo."
  },
  "c1r3": {
    "name": "Grind às cegas — saída limpa",
    "desc": "A mesma linha, enfim concluída sem falhas."
  },
  "c1r4": {
    "name": "Salto da cerca",
    "desc": "Passou a cerca vigiada de primeira."
  },
  "c1r5": {
    "name": "Salto da cerca — volta",
    "desc": "O mesmo salto de volta, em plena luz do dia."
  },
  "c1r6": {
    "name": "Perna de osso",
    "desc": "Dizem que andou uma semana com as duas pernas quebradas."
  },
  "c1r7": {
    "name": "Perna de osso — revanche",
    "desc": "A mesma história, duas fraturas depois."
  },
  "c1r8": {
    "name": "540 no telhado",
    "desc": "Não há gravação. Só testemunhas."
  },
  "c2r0": {
    "name": "Tag rápida",
    "desc": "Uma linha pintada no minuto antes da partida."
  },
  "c2r1": {
    "name": "Tag rápida — segundo vagão",
    "desc": "Mesmo artista, mesma noite, vagão ao lado."
  },
  "c2r2": {
    "name": "Obra de uma noite",
    "desc": "Uma obra completa antes do amanhecer, sem segunda chance."
  },
  "c2r3": {
    "name": "Obra de uma noite — continuação",
    "desc": "Concluída na próxima parada."
  },
  "c2r4": {
    "name": "Passou por três estados",
    "desc": "Avistamentos confirmados em três regiões."
  },
  "c2r5": {
    "name": "Passou por três estados — seguiu viagem",
    "desc": "Avistado ainda mais longe."
  },
  "c2r6": {
    "name": "O vagão invisível",
    "desc": "Pintado num pátio onde ninguém deveria entrar."
  },
  "c2r7": {
    "name": "O vagão invisível — segunda viagem",
    "desc": "A mesma equipe voltou para mais."
  },
  "c2r8": {
    "name": "A viagem sem fim",
    "desc": "Nunca apagado. Ainda nos trilhos, dez anos depois."
  },
  "c3r0": {
    "name": "Par encharcado",
    "desc": "Restauração básica, direto do bueiro."
  },
  "c3r1": {
    "name": "Par encharcado — segunda enchente",
    "desc": "Resgatado e costurado outra vez."
  },
  "c3r2": {
    "name": "Costura dupla",
    "desc": "Duas linhas paralelas na cor da coleção."
  },
  "c3r3": {
    "name": "Costura dupla — terceira passada",
    "desc": "Uma terceira linha acrescentada ao padrão."
  },
  "c3r4": {
    "name": "Lote de uma tempestade",
    "desc": "Costurado numa única tempestade nomeada. Nunca repetido."
  },
  "c3r5": {
    "name": "Lote de uma tempestade — segunda onda",
    "desc": "Um lote extra da mesma tempestade."
  },
  "c3r6": {
    "name": "O último par do sapateiro",
    "desc": "Uma das últimas obras conhecidas de Ponto Enferrujado."
  },
  "c3r7": {
    "name": "O último par do sapateiro — achado tardio",
    "desc": "Encontrado anos depois de ele desaparecer."
  },
  "c3r8": {
    "name": "O primeiro par",
    "desc": "O primeiro par que ele restaurou."
  },
  "c4r0": {
    "name": "Primeiro scratch",
    "desc": "Uma técnica básica de DJ, nada demais."
  },
  "c4r1": {
    "name": "Primeiro scratch — bis",
    "desc": "A mesma técnica, repetida para uma plateia mais animada."
  },
  "c4r2": {
    "name": "Moinho no asfalto",
    "desc": "Um passo de breaking que poucos conseguem."
  },
  "c4r3": {
    "name": "Moinho no asfalto — giro duplo",
    "desc": "A versão mais difícil do mesmo passo."
  },
  "c4r4": {
    "name": "Dois MCs, um microfone",
    "desc": "O troféu de uma batalha que todos lembram."
  },
  "c4r5": {
    "name": "Dois MCs, um microfone — revanche",
    "desc": "Os mesmos dois, agora com os papéis trocados."
  },
  "c4r6": {
    "name": "O som que nunca parou",
    "desc": "Tocou 72 horas seguidas com energia roubada."
  },
  "c4r7": {
    "name": "O som que nunca parou — segunda noite",
    "desc": "O mesmo aparelho resistiu a outra rodada."
  },
  "c4r8": {
    "name": "A primeira festa do bairro",
    "desc": "O troféu da festa que começou tudo."
  },
  "c5r0": {
    "name": "Pombo batedor",
    "desc": "Um vigia no telhado, nada mais."
  },
  "c5r1": {
    "name": "Pombo batedor — segundo ninho",
    "desc": "A mesma ave tomou outro telhado."
  },
  "c5r2": {
    "name": "Gato caolho do bairro",
    "desc": "O vigia não oficial da vizinhança."
  },
  "c5r3": {
    "name": "Gato caolho do bairro — nova marca",
    "desc": "Mais um quarteirão virou seu território."
  },
  "c5r4": {
    "name": "Esquadrão de guaxinins",
    "desc": "Três guaxinins, uma lixeira, sincronia perfeita."
  },
  "c5r5": {
    "name": "Esquadrão de guaxinins — segundo ataque",
    "desc": "A mesma equipe, um prêmio maior."
  },
  "c5r6": {
    "name": "Rainha dos telhados",
    "desc": "A matriarca dos pombos que ninguém descreveu por completo."
  },
  "c5r7": {
    "name": "Rainha dos telhados — nova ninhada",
    "desc": "Espalham-se notícias de seus filhotes."
  },
  "c5r8": {
    "name": "A coisa sob a cidade",
    "desc": "Nunca vista por inteiro. Nunca será."
  },
  "c6r0": {
    "name": "Primeira moeda",
    "desc": "Só mais uma moeda na máquina."
  },
  "c6r1": {
    "name": "Primeira moeda — continuar",
    "desc": "O mesmo jogador insere a segunda moeda."
  },
  "c6r2": {
    "name": "Fase secreta",
    "desc": "Uma fase oculta que ninguém deveria achar."
  },
  "c6r3": {
    "name": "Fase secreta — segunda rota",
    "desc": "A mesma fase, vencida de outro jeito."
  },
  "c6r4": {
    "name": "Recorde na máquina quebrada",
    "desc": "Feito numa máquina que todos descartaram."
  },
  "c6r5": {
    "name": "Recorde na máquina quebrada — superado",
    "desc": "O mesmo jogador bateu o próprio recorde."
  },
  "c6r6": {
    "name": "Zero triplo",
    "desc": "Uma suposta pontuação perfeita, ainda contestada."
  },
  "c6r7": {
    "name": "Zero triplo — repetição",
    "desc": "Rumores de que a mesma pontuação foi repetida."
  },
  "c6r8": {
    "name": "A máquina que não existe",
    "desc": "Vista uma vez, num porão diferente a cada relato."
  },
  "c7r0": {
    "name": "Boato de rua",
    "desc": "Só mais uma história circulando."
  },
  "c7r1": {
    "name": "Boato de rua — recontado",
    "desc": "A mesma história, alterada ao ser recontada."
  },
  "c7r2": {
    "name": "Lenda registrada",
    "desc": "Uma história que alguém finalmente registrou."
  },
  "c7r3": {
    "name": "Lenda registrada — nota de rodapé",
    "desc": "O mesmo relato, com novos detalhes."
  },
  "c7r4": {
    "name": "Onde duas histórias se cruzam",
    "desc": "O encontro das lendas de dois bairros."
  },
  "c7r5": {
    "name": "Onde duas histórias se cruzam — terceiro bairro",
    "desc": "O mesmo encontro, agora com uma terceira cena."
  },
  "c7r6": {
    "name": "A noite em que a cidade não dormiu",
    "desc": "Oito bairros, uma noite impossível."
  },
  "c7r7": {
    "name": "A noite em que a cidade não dormiu — de novo?",
    "desc": "Um boato não confirmado de uma segunda noite."
  },
  "c7r8": {
    "name": "O primeiro boato",
    "desc": "O mito que teria dado origem a toda essa cultura."
  },
  "d0": {
    "name": "Mariposa noturna",
    "district": "O antigo bairro industrial",
    "theme": "Arte de rua com estêncil, artista anônimo",
    "history": "A cada lua nova, uma mariposa surge num armazém: com maleta, atrás das grades ou com uma cédula. Ninguém viu o artista. A limpeza apaga tudo de manhã, mas os Guardiões, antigos exploradores urbanos, fotografam as obras e encontram uma tampinha sob cada uma. Assim começa a história das tampinhas carregadas de Gutter Caps."
  },
  "d1": {
    "name": "Diabos do asfalto",
    "district": "As piscinas vazias",
    "theme": "Skate e BMX",
    "history": "Uma seca esvaziou as piscinas, e adolescentes fizeram delas um skatepark clandestino. O Clã do Concreto Seco ficou famoso em vídeos tremidos: pernas quebradas, saltos impossíveis. As piscinas foram demolidas para construir apartamentos. As tampinhas com nomes dos truques continuam sendo a única moeda que importa aqui."
  },
  "d2": {
    "name": "Reis dos trilhos",
    "district": "O pátio de cargas",
    "theme": "Grafite em trens",
    "history": "Aqui as equipes disputam vagões, não paredes: um trem leva seus nomes a cidades distantes. Os guardas noturnos são os Observadores. Antes, os avistamentos das obras nas estações eram anotados num caderno. Agora esse registro vive na blockchain e ninguém pode reescrever o passado da viagem."
  },
  "d3": {
    "name": "Solas do bueiro",
    "district": "O mercado sob o viaduto",
    "theme": "Cultura dos tênis, restauração",
    "history": "As enchentes levam os tênis encalhados do mercado para os bueiros. Mergulhadores os resgatam, e o sapateiro Ponto Enferrujado os restaura. A cor de sua linha virou a assinatura de carga da coleção. Como falsificações são um problema constante, a procedência registrada na blockchain importa aqui mais do que nunca."
  },
  "d4": {
    "name": "Bairro do boombox",
    "district": "O quarteirão",
    "theme": "Hip-hop, breaking e batalhas de MCs",
    "history": "Todo verão há uma festa alimentada por um poste: não chamam de crime, mas de tradição. Rodas de breaking fazem lendas; MCs rimam até amanhecer; aparelhos de som passam de geração em geração. As tampinhas eram troféus de batalha muito antes de a ideia conquistar a cidade."
  },
  "d5": {
    "name": "Feras do bueiro",
    "district": "Esgotos e vielas",
    "theme": "Folclore da fauna urbana",
    "history": "As crianças contam sobre um reino escondido: um gato caolho domina um quarteirão, pombos votam nos telhados e guaxinins atacam lixeiras com precisão militar. Não são vilões, mas espíritos astutos das ruas. As tampinhas desta coleção saem dos mesmos bueiros onde essas criaturas supostamente vivem."
  },
  "d6": {
    "name": "Porão pixel",
    "district": "Os fliperamas de porão",
    "theme": "Cultura dos fliperamas retrô",
    "history": "Quando os fliperamas fecharam, suas máquinas viraram sucata e foram reconstruídas em porões secretos. Os jogos são meio quebrados, meio reinventados; os nomes originais foram esquecidos. Mandam os recordistas, com iniciais numa placa nunca apagada. Caçadores de falhas também conquistam seu respeito."
  },
  "d7": {
    "name": "Mitos da cidade",
    "district": "A cidade inteira",
    "theme": "Coleção que reúne as lendas das outras sete",
    "history": "Aqui se registram os rumores sobre a Mariposa, o Vagão Invisível e a coisa sob a cidade. A coleção não repete tampinhas dos outros bairros: cruza suas histórias. Foi pensada como uma temporada final para quem conhece as lendas. Sua tampinha Diamante fecha o ciclo, voltando à primeira coleção."
  }
} satisfies Catalog;
export default catalog;
