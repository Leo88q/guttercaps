import type en from './en';
type Catalog = { [K in keyof typeof en]: { [P in keyof (typeof en)[K]]: string } };
const catalog = {
  "c0r0": {
    "name": "Polilla rápida",
    "desc": "Un boceto de una capa, aún húmedo en los bordes."
  },
  "c0r1": {
    "name": "Polilla bajo la segunda lluvia",
    "desc": "El mismo boceto, abrillantado por otra inundación."
  },
  "c0r2": {
    "name": "Polilla con maletín",
    "desc": "Una obra en capas con una mordaz crítica social."
  },
  "c0r3": {
    "name": "Polilla con maletín — segunda capa",
    "desc": "Repintada sobre el original borrado."
  },
  "c0r4": {
    "name": "Polilla entre rejas",
    "desc": "La obra que el barrio debatió durante una semana."
  },
  "c0r5": {
    "name": "Polilla entre rejas — registro",
    "desc": "La misma escena, ahora fechada y firmada."
  },
  "c0r6": {
    "name": "La noche de las tres paredes",
    "desc": "Tres obras, tres barrios, una noche."
  },
  "c0r7": {
    "name": "La noche de las tres paredes — cuarta pared",
    "desc": "Un cuarto avistamiento sin confirmar."
  },
  "c0r8": {
    "name": "La carga original",
    "desc": "La primera chapa dejada junto a la primera obra. Solo existe una."
  },
  "c1r0": {
    "name": "Primera bajada",
    "desc": "La primera entrada en la piscina de patinaje."
  },
  "c1r1": {
    "name": "Segundo intento",
    "desc": "La misma bajada, completada al segundo intento."
  },
  "c1r2": {
    "name": "Grind a ciegas",
    "desc": "Un grind sin mirar abajo."
  },
  "c1r3": {
    "name": "Grind a ciegas — salida limpia",
    "desc": "La misma línea, por fin completada sin fallos."
  },
  "c1r4": {
    "name": "Salto de la valla",
    "desc": "Superó la valla vigilada de un salto."
  },
  "c1r5": {
    "name": "Salto de la valla — regreso",
    "desc": "El mismo salto de vuelta, a plena luz del día."
  },
  "c1r6": {
    "name": "Pierna de hueso",
    "desc": "Dicen que patinó una semana con ambas piernas rotas."
  },
  "c1r7": {
    "name": "Pierna de hueso — revancha",
    "desc": "La misma historia, dos fracturas después."
  },
  "c1r8": {
    "name": "540 en el tejado",
    "desc": "No hay grabación. Solo testigos."
  },
  "c2r0": {
    "name": "Tag rápida",
    "desc": "Una línea pintada un minuto antes de partir."
  },
  "c2r1": {
    "name": "Tag rápida — segundo vagón",
    "desc": "Mismo artista, misma noche, vagón de al lado."
  },
  "c2r2": {
    "name": "Obra de una noche",
    "desc": "Una obra completa antes del amanecer, sin segundas oportunidades."
  },
  "c2r3": {
    "name": "Obra de una noche — continuación",
    "desc": "Terminada en la siguiente parada."
  },
  "c2r4": {
    "name": "Recorrió tres estados",
    "desc": "Avistamientos confirmados en tres regiones."
  },
  "c2r5": {
    "name": "Recorrió tres estados — siguió viajando",
    "desc": "Visto aún más lejos."
  },
  "c2r6": {
    "name": "El vagón invisible",
    "desc": "Pintado en un depósito donde nadie debía entrar."
  },
  "c2r7": {
    "name": "El vagón invisible — segundo viaje",
    "desc": "El mismo grupo volvió por más."
  },
  "c2r8": {
    "name": "El viaje sin fin",
    "desc": "Nunca borrado. Sigue rodando diez años después."
  },
  "c3r0": {
    "name": "Par empapado",
    "desc": "Restauración básica, directo del desagüe."
  },
  "c3r1": {
    "name": "Par empapado — segunda inundación",
    "desc": "Rescatado y cosido otra vez."
  },
  "c3r2": {
    "name": "Costura doble",
    "desc": "Dos hilos paralelos del color de la colección."
  },
  "c3r3": {
    "name": "Costura doble — tercera pasada",
    "desc": "Un tercer hilo añadido al patrón."
  },
  "c3r4": {
    "name": "Lote de una tormenta",
    "desc": "Cosido durante una única tormenta con nombre. Nunca repetido."
  },
  "c3r5": {
    "name": "Lote de una tormenta — segunda ola",
    "desc": "Un lote extra de la misma tormenta."
  },
  "c3r6": {
    "name": "El último par del zapatero",
    "desc": "Una de las últimas obras conocidas de Puntada Oxidada."
  },
  "c3r7": {
    "name": "El último par del zapatero — hallazgo tardío",
    "desc": "Apareció años después de su desaparición."
  },
  "c3r8": {
    "name": "El primer par",
    "desc": "El primer par que restauró."
  },
  "c4r0": {
    "name": "Primer scratch",
    "desc": "Una técnica básica de DJ, nada especial."
  },
  "c4r1": {
    "name": "Primer scratch — bis",
    "desc": "La misma técnica, repetida para un público más ruidoso."
  },
  "c4r2": {
    "name": "Molino en el asfalto",
    "desc": "Un paso de breaking que pocos logran."
  },
  "c4r3": {
    "name": "Molino en el asfalto — giro doble",
    "desc": "La versión más difícil del mismo paso."
  },
  "c4r4": {
    "name": "Dos MC, un micrófono",
    "desc": "La ficha de una batalla que todos recuerdan."
  },
  "c4r5": {
    "name": "Dos MC, un micrófono — revancha",
    "desc": "Los mismos dos, ahora con los papeles cambiados."
  },
  "c4r6": {
    "name": "El radiocasete que no paraba",
    "desc": "Sonó 72 horas seguidas con electricidad robada."
  },
  "c4r7": {
    "name": "El radiocasete que no paraba — segunda noche",
    "desc": "El mismo aparato resistió otra ronda."
  },
  "c4r8": {
    "name": "La primera fiesta del barrio",
    "desc": "La ficha de la fiesta que lo inició todo."
  },
  "c5r0": {
    "name": "Paloma exploradora",
    "desc": "Un vigía en el tejado, nada más."
  },
  "c5r1": {
    "name": "Paloma exploradora — segundo nido",
    "desc": "La misma ave ocupó otro tejado."
  },
  "c5r2": {
    "name": "Gato tuerto del barrio",
    "desc": "El guardián no oficial del vecindario."
  },
  "c5r3": {
    "name": "Gato tuerto del barrio — nueva marca",
    "desc": "Otro bloque añadido a su territorio."
  },
  "c5r4": {
    "name": "Escuadrón de mapaches",
    "desc": "Tres mapaches, un contenedor, sincronía perfecta."
  },
  "c5r5": {
    "name": "Escuadrón de mapaches — segundo asalto",
    "desc": "El mismo grupo, un botín mayor."
  },
  "c5r6": {
    "name": "Reina de los tejados",
    "desc": "La matriarca de las palomas que nadie describió del todo."
  },
  "c5r7": {
    "name": "Reina de los tejados — nueva nidada",
    "desc": "Se difunden noticias de sus crías."
  },
  "c5r8": {
    "name": "La cosa bajo la ciudad",
    "desc": "Nunca vista por completo. Nunca lo será."
  },
  "c6r0": {
    "name": "Primera moneda",
    "desc": "Otra moneda más en la máquina."
  },
  "c6r1": {
    "name": "Primera moneda — continuar",
    "desc": "El mismo jugador mete otra moneda."
  },
  "c6r2": {
    "name": "Nivel secreto",
    "desc": "Una fase oculta que nadie debía encontrar."
  },
  "c6r3": {
    "name": "Nivel secreto — segunda ruta",
    "desc": "El mismo nivel, superado de otra forma."
  },
  "c6r4": {
    "name": "Récord en la máquina rota",
    "desc": "Logrado en una máquina que todos descartaron."
  },
  "c6r5": {
    "name": "Récord en la máquina rota — superado",
    "desc": "El mismo jugador superó su récord."
  },
  "c6r6": {
    "name": "Triple cero",
    "desc": "Una supuesta puntuación perfecta, aún discutida."
  },
  "c6r7": {
    "name": "Triple cero — repetición",
    "desc": "Rumores de que se repitió la puntuación."
  },
  "c6r8": {
    "name": "La máquina que no existe",
    "desc": "Vista una vez, en un sótano distinto en cada relato."
  },
  "c7r0": {
    "name": "Rumor callejero",
    "desc": "Otra historia que circula."
  },
  "c7r1": {
    "name": "Rumor callejero — recontado",
    "desc": "La misma historia, cambiada al contarla."
  },
  "c7r2": {
    "name": "Leyenda escrita",
    "desc": "Una historia que alguien por fin registró."
  },
  "c7r3": {
    "name": "Leyenda escrita — nota al pie",
    "desc": "El mismo relato, con nuevos detalles."
  },
  "c7r4": {
    "name": "Donde se cruzan dos historias",
    "desc": "El encuentro de las leyendas de dos barrios."
  },
  "c7r5": {
    "name": "Donde se cruzan dos historias — tercer barrio",
    "desc": "El mismo encuentro, ahora con una tercera escena."
  },
  "c7r6": {
    "name": "La noche en que la ciudad no durmió",
    "desc": "Ocho barrios, una noche imposible."
  },
  "c7r7": {
    "name": "La noche en que la ciudad no durmió — ¿otra vez?",
    "desc": "Un rumor sin confirmar sobre una segunda noche."
  },
  "c7r8": {
    "name": "El primer rumor",
    "desc": "El mito del que habría nacido toda esta cultura."
  },
  "d0": {
    "name": "Polilla nocturna",
    "district": "El antiguo barrio industrial",
    "theme": "Arte urbano con plantillas, artista anónimo",
    "history": "Cada luna nueva aparece una polilla en un almacén: con maletín, entre rejas o con una papeleta. Nadie ha visto al artista. La limpieza la borra al amanecer, pero los Guardianes, antiguos exploradores urbanos, fotografían cada obra y encuentran una chapa debajo. Así empieza la historia de las chapas cargadas de Gutter Caps."
  },
  "d1": {
    "name": "Diablos del asfalto",
    "district": "Las piscinas vacías",
    "theme": "Skate y BMX",
    "history": "Una sequía vació las piscinas y los adolescentes las convirtieron en un skatepark clandestino. El Clan del Hormigón Seco se hizo famoso con vídeos temblorosos: piernas rotas, saltos imposibles. Las piscinas se demolieron para construir viviendas. Las chapas con nombres de trucos siguen siendo la única moneda que importa aquí."
  },
  "d2": {
    "name": "Reyes de los rieles",
    "district": "El patio de mercancías",
    "theme": "Grafiti en trenes",
    "history": "Aquí los grupos disputan vagones, no paredes: un tren lleva sus nombres a ciudades lejanas. Los guardias nocturnos son los Vigilantes. Antes, los avistamientos se anotaban en un cuaderno. Ahora ese registro vive en la cadena y nadie puede reescribir el pasado del viaje."
  },
  "d3": {
    "name": "Suelas del desagüe",
    "district": "El mercado bajo el viaducto",
    "theme": "Cultura de zapatillas, restauración",
    "history": "Las inundaciones arrastran al desagüe las zapatillas sin vender. Los buzos las rescatan y el zapatero Puntada Oxidada las restaura. El color de su hilo es la firma de carga de la colección. Las falsificaciones son un problema eterno, así que la procedencia en cadena importa aquí más que nunca."
  },
  "d4": {
    "name": "Barrio del boombox",
    "district": "La manzana",
    "theme": "Hip-hop, breaking y batallas de MC",
    "history": "Cada verano hay una fiesta conectada a una farola: no lo llaman delito, sino tradición. El breaking crea leyendas, los MC riman hasta el amanecer y los radiocasetes se heredan como reliquias. Las chapas eran trofeos de batallas mucho antes de que la idea conquistara la ciudad."
  },
  "d5": {
    "name": "Bestias del desagüe",
    "district": "Alcantarillas y callejones",
    "theme": "Folclore de la fauna urbana",
    "history": "Los niños hablan de un reino oculto: un gato tuerto domina una manzana, palomas votan en los tejados y mapaches asaltan contenedores con precisión militar. No son villanos, sino astutos espíritus callejeros. Las chapas salen de los mismos desagües donde se dice que viven estas criaturas."
  },
  "d6": {
    "name": "Sótano píxel",
    "district": "Los salones recreativos del sótano",
    "theme": "Cultura de recreativas retro",
    "history": "Al cerrar los salones, sus máquinas se vendieron como chatarra y renacieron en sótanos secretos. Los juegos están medio rotos, medio reinventados; nadie recuerda los nombres originales. Mandan los campeones que graban sus iniciales en un tablero nunca borrado. Los cazadores de fallos ganan su propio respeto."
  },
  "d7": {
    "name": "Mitos de la ciudad",
    "district": "Toda la ciudad",
    "theme": "Colección de las leyendas de las otras siete",
    "history": "Aquí se registran rumores sobre la Polilla, el Vagón Invisible y la cosa bajo la ciudad. No se repiten chapas de otros barrios: se cruzan sus historias. La colección se pensó como temporada final para quienes conocen las leyendas. Su chapa Diamante cierra el círculo hacia la primera colección."
  }
} satisfies Catalog;
export default catalog;
