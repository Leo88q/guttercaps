import type en from './en';
type Catalog = { [K in keyof typeof en]: { [P in keyof (typeof en)[K]]: string } };
const catalog = {
  "c0r0": {
    "name": "Mabilis na gamu-gamo",
    "desc": "Magaspang na guhit na isang patong, basa pa ang mga gilid."
  },
  "c0r1": {
    "name": "Gamu-gamo sa ikalawang ulan",
    "desc": "Ang parehong guhit, pinakintab ng panibagong baha."
  },
  "c0r2": {
    "name": "Gamu-gamong may portpolyo",
    "desc": "Patong-patong na likha na may matalim na puna sa lipunan."
  },
  "c0r3": {
    "name": "Gamu-gamong may portpolyo — ikalawang patong",
    "desc": "Ipininta muli sa ibabaw ng binurang orihinal."
  },
  "c0r4": {
    "name": "Gamu-gamo sa rehas",
    "desc": "Ang likhang pinagtalunan ng buong bloke sa loob ng isang linggo."
  },
  "c0r5": {
    "name": "Gamu-gamo sa rehas — tala",
    "desc": "Ang parehong eksena, may petsa at lagda na."
  },
  "c0r6": {
    "name": "Gabi ng tatlong pader",
    "desc": "Tatlong likha, tatlong distrito, iisang gabi."
  },
  "c0r7": {
    "name": "Gabi ng tatlong pader — ikaapat na pader",
    "desc": "Hindi kumpirmadong pagkakita sa ikaapat."
  },
  "c0r8": {
    "name": "Tunay na karga",
    "desc": "Ang unang takip sa unang likha. Iisa lang."
  },
  "c1r0": {
    "name": "Unang lusong",
    "desc": "Ang pinakaunang paglusong sa bowl."
  },
  "c1r1": {
    "name": "Ikalawang subok",
    "desc": "Ang parehong lusong, malinis na nagawa sa pag-ulit."
  },
  "c1r2": {
    "name": "Grind na pikit",
    "desc": "Isang grind na hindi tumingin pababa."
  },
  "c1r3": {
    "name": "Grind na pikit — malinis na labas",
    "desc": "Ang parehong linya, sa wakas maayos na natapos."
  },
  "c1r4": {
    "name": "Talon sa bakod",
    "desc": "Nalampasan ang binabantayang bakod sa isang talon."
  },
  "c1r5": {
    "name": "Talon sa bakod — pagbabalik",
    "desc": "Ang parehong talon pabalik, sa katanghaliang-tapat."
  },
  "c1r6": {
    "name": "Binting buto",
    "desc": "Sabi nila, nag-skate nang isang linggo na bali ang dalawang binti."
  },
  "c1r7": {
    "name": "Binting buto — rematch",
    "desc": "Ang parehong kuwento, makalipas ang dalawa pang bali."
  },
  "c1r8": {
    "name": "540 sa bubong",
    "desc": "Walang video. Mga saksi lang."
  },
  "c2r0": {
    "name": "Mabilis na tag",
    "desc": "Isang linyang ipininta isang minuto bago umalis."
  },
  "c2r1": {
    "name": "Mabilis na tag — ikalawang bagon",
    "desc": "Parehong artist at gabi, sa katabing bagon."
  },
  "c2r2": {
    "name": "Obra sa isang gabi",
    "desc": "Buong likha bago magbukang-liwayway, walang ikalawang pagkakataon."
  },
  "c2r3": {
    "name": "Obra sa isang gabi — kasunod",
    "desc": "Tinapos sa susunod na istasyon."
  },
  "c2r4": {
    "name": "Dumaan sa tatlong estado",
    "desc": "Kumpirmadong nakita sa tatlong rehiyon."
  },
  "c2r5": {
    "name": "Dumaan sa tatlong estado — tuloy pa",
    "desc": "Nakita sa mas malayo pa."
  },
  "c2r6": {
    "name": "Di-nakikitang bagon",
    "desc": "Ipininta sa depot na hindi dapat mapasok ninuman."
  },
  "c2r7": {
    "name": "Di-nakikitang bagon — ikalawang biyahe",
    "desc": "Bumalik muli ang parehong grupo."
  },
  "c2r8": {
    "name": "Walang-hanggang biyahe",
    "desc": "Hindi kailanman binura. Tumatakbo pa rin matapos ang sampung taon."
  },
  "c3r0": {
    "name": "Basang pares",
    "desc": "Simpleng pagpapanumbalik, mula mismo sa kanal."
  },
  "c3r1": {
    "name": "Basang pares — ikalawang baha",
    "desc": "Nakuha muli, tinahing muli."
  },
  "c3r2": {
    "name": "Dobleng tahi",
    "desc": "Dalawang magkatabing sinulid sa kulay ng koleksiyon."
  },
  "c3r3": {
    "name": "Dobleng tahi — ikatlong daan",
    "desc": "Idinagdag ang ikatlong sinulid sa disenyo."
  },
  "c3r4": {
    "name": "Batch ng isang bagyo",
    "desc": "Tinahi sa iisang pinangalanang bagyo. Hindi na naulit."
  },
  "c3r5": {
    "name": "Batch ng isang bagyo — ikalawang alon",
    "desc": "Dagdag na batch mula sa parehong bagyo."
  },
  "c3r6": {
    "name": "Huling pares ng sapatero",
    "desc": "Isa sa mga huling kilalang likha ni Kalawang na Tahi."
  },
  "c3r7": {
    "name": "Huling pares ng sapatero — natagpuan sa huli",
    "desc": "Lumitaw ilang taon matapos siyang mawala."
  },
  "c3r8": {
    "name": "Pinakaunang pares",
    "desc": "Ang unang pares na ibinalik niya sa ayos."
  },
  "c4r0": {
    "name": "Unang scratch",
    "desc": "Simpleng galaw ng DJ, walang espesyal."
  },
  "c4r1": {
    "name": "Unang scratch — encore",
    "desc": "Inulit na galaw para sa mas maingay na madla."
  },
  "c4r2": {
    "name": "Windmill sa aspalto",
    "desc": "Galaw sa breaking na iilan lang ang nakakagawa."
  },
  "c4r3": {
    "name": "Windmill sa aspalto — dobleng ikot",
    "desc": "Mas mahirap na bersiyon ng parehong galaw."
  },
  "c4r4": {
    "name": "Dalawang MC, isang mic",
    "desc": "Token ng panalo sa laban na naaalala ng lahat."
  },
  "c4r5": {
    "name": "Dalawang MC, isang mic — rematch",
    "desc": "Parehong dalawa, palit ng puwesto ngayon."
  },
  "c4r6": {
    "name": "Boombox na hindi tumigil",
    "desc": "Tumugtog nang 72 oras gamit ang nakaw na kuryente."
  },
  "c4r7": {
    "name": "Boombox na hindi tumigil — ikalawang gabi",
    "desc": "Ang parehong boombox, kinaya ang pag-ulit."
  },
  "c4r8": {
    "name": "Unang pista ng bloke",
    "desc": "Token mula sa pistang nagsimula ng lahat."
  },
  "c5r0": {
    "name": "Kalapating tagamanman",
    "desc": "Bantay sa bubong, iyon lang."
  },
  "c5r1": {
    "name": "Kalapating tagamanman — ikalawang pugad",
    "desc": "Parehong ibon, bagong bubong ang inangkin."
  },
  "c5r2": {
    "name": "Pusang may isang mata",
    "desc": "Di-opisyal na bantay ng kapitbahayan."
  },
  "c5r3": {
    "name": "Pusang may isang mata — bagong marka",
    "desc": "Isa pang bloke ang inangking teritoryo."
  },
  "c5r4": {
    "name": "Pangkat ng mga raccoon",
    "desc": "Tatlong raccoon, isang basurahan, perpektong tiyempo."
  },
  "c5r5": {
    "name": "Pangkat ng mga raccoon — ikalawang pagsalakay",
    "desc": "Parehong grupo, mas malaking pakinabang."
  },
  "c5r6": {
    "name": "Reyna ng mga bubong",
    "desc": "Inang kalapati na walang ganap na nakapaglarawan."
  },
  "c5r7": {
    "name": "Reyna ng mga bubong — bagong inakay",
    "desc": "Kumakalat ang balita tungkol sa mga anak niya."
  },
  "c5r8": {
    "name": "Nilalang sa ilalim ng lungsod",
    "desc": "Hindi pa nakitang buo. Hindi kailanman."
  },
  "c6r0": {
    "name": "Unang barya",
    "desc": "Isa na namang baryang inihulog sa makina."
  },
  "c6r1": {
    "name": "Unang barya — magpatuloy",
    "desc": "Parehong manlalaro, naghuhulog ng ikalawang barya."
  },
  "c6r2": {
    "name": "Lihim na level",
    "desc": "Nakatagong yugto na hindi dapat matagpuan."
  },
  "c6r3": {
    "name": "Lihim na level — ikalawang ruta",
    "desc": "Parehong level, natapos sa ibang paraan."
  },
  "c6r4": {
    "name": "Rekord sa sirang makina",
    "desc": "Naitala sa makinang sinukuan na ng lahat."
  },
  "c6r5": {
    "name": "Rekord sa sirang makina — nalampasan",
    "desc": "Binasag ng parehong manlalaro ang sariling rekord."
  },
  "c6r6": {
    "name": "Tatlong sero",
    "desc": "Diumano'y perpektong iskor, pinagtatalunan pa rin."
  },
  "c6r7": {
    "name": "Tatlong sero — pag-ulit",
    "desc": "Balitang naulit ang parehong iskor."
  },
  "c6r8": {
    "name": "Makinang hindi umiiral",
    "desc": "Minsang nakita, sa ibang silong sa bawat kuwento."
  },
  "c7r0": {
    "name": "Usap-usapan sa kalye",
    "desc": "Isa na namang kuwentong kumakalat."
  },
  "c7r1": {
    "name": "Usap-usapan sa kalye — muling kuwento",
    "desc": "Parehong kuwento, nagbago sa pagkukuwento."
  },
  "c7r2": {
    "name": "Naisulat na alamat",
    "desc": "Kuwentong sa wakas ay may nagsulat."
  },
  "c7r3": {
    "name": "Naisulat na alamat — talababa",
    "desc": "Parehong salaysay, may mga bagong detalye."
  },
  "c7r4": {
    "name": "Tagpuan ng dalawang kuwento",
    "desc": "Sandaling nagtagpo ang alamat ng dalawang distrito."
  },
  "c7r5": {
    "name": "Tagpuan ng dalawang kuwento — ikatlong distrito",
    "desc": "Parehong tagpuan, may ikatlong kultura na."
  },
  "c7r6": {
    "name": "Gabing hindi natulog ang lungsod",
    "desc": "Walong distrito, isang gabing di-kapani-paniwala."
  },
  "c7r7": {
    "name": "Gabing hindi natulog ang lungsod — muli?",
    "desc": "Hindi kumpirmadong balita ng ikalawang gabi."
  },
  "c7r8": {
    "name": "Unang usap-usapan",
    "desc": "Alamat na sinasabing pinagmulan ng buong kulturang ito."
  },
  "d0": {
    "name": "Gamu-gamo sa gabi",
    "district": "Lumang distrito ng industriya",
    "theme": "Stencil na sining sa kalye, di-kilalang pintor",
    "history": "Tuwing bagong buwan, may gamu-gamo sa dingding ng bodega: may portpolyo, nasa rehas o may balota. Walang nakakita sa artist. Binubura ito sa umaga, pero nakukunan ng larawan ng mga Tagapag-ingat, dating urban explorer. May takip sa ilalim ng bawat likha. Dito nagsimula ang mga takip na may karga ng Gutter Caps."
  },
  "d1": {
    "name": "Mga demonyo ng aspalto",
    "district": "Mga tuyong swimming pool",
    "theme": "Skate at BMX",
    "history": "Natuyo ang mga pool dahil sa tagtuyot; ginawa itong lihim na skatepark ng kabataan. Sumikat ang Angkan ng Tuyong Semento sa maliligalig na video: sirang binti, imposibleng talon. Giniba na ang mga pool para sa pabahay. Mga takip na may pangalan ng trick pa rin ang tanging mahalagang salapi rito."
  },
  "d2": {
    "name": "Mga hari ng riles",
    "district": "Bakuran ng kargamentong tren",
    "theme": "Graffiti sa tren",
    "history": "Bagon, hindi pader, ang pinag-aagawan dito: dadalhin ng tren ang pangalan ng grupo sa malalayong lungsod. Tagamasid ang tawag sa bantay-gabi. Dati, nasa kuwaderno ang tala ng mga likhang nakita sa istasyon. Ngayon, nasa blockchain ito at hindi na mababago ang nakaraan ng biyahe."
  },
  "d3": {
    "name": "Talampakan ng kanal",
    "district": "Pamilihan sa ilalim ng overpass",
    "theme": "Kultura ng sneaker, pagpapanumbalik",
    "history": "Inaanod ng baha ang hindi nabentang sapatos sa kanal. Kinukuha ng maninisid at inaayos ng sapaterong Kalawang na Tahi. Naging tanda ng karga ng koleksiyon ang kulay ng kanyang sinulid. Dahil laging problema ang pekeng sneaker, napakahalaga rito ng pinagmulan sa blockchain."
  },
  "d4": {
    "name": "Bloke ng boombox",
    "district": "Ang bloke",
    "theme": "Hip-hop, breaking at laban ng MC",
    "history": "Tuwing tag-init, may pistang kumukuha ng kuryente sa poste: tradisyon ang tawag, hindi krimen. Nagkakaroon ng mga alamat sa breaking, nagririmahan ang MC hanggang umaga, ipinapamana ang boombox. Mga token ng panalo sa laban ang mga takip bago pa kumalat ang ideya sa lungsod."
  },
  "d5": {
    "name": "Mga hayop ng kanal",
    "district": "Alkantarilya at mga eskinita",
    "theme": "Alamat ng mga hayop sa lungsod",
    "history": "Kuwento ng mga bata ang lihim na kaharian: pusang may isang mata na hari ng bloke, kalapating bumoboto sa bubong, raccoon na sumasalakay sa basura na parang sundalo. Hindi sila kontrabida, kundi tusong espiritu ng kalye. Sa mismong mga kanal na tirahan nila lumilitaw ang mga takip."
  },
  "d6": {
    "name": "Silong pixel",
    "district": "Mga arcade sa silong",
    "theme": "Kultura ng retro arcade",
    "history": "Nang magsara ang arcade, ibinenta ang makina bilang bakal at binuo muli sa lihim na silong. Kalahating sira, kalahating imbento ang laro; limot na ang orihinal na pangalan. Namumuno ang rekordista na may inisyal sa pisarang hindi binubura. May sariling respeto ang mga mangangaso ng glitch."
  },
  "d7": {
    "name": "Mga alamat ng lungsod",
    "district": "Buong lungsod",
    "theme": "Koleksiyong nag-uugnay sa alamat ng pitong iba pa",
    "history": "Dito nakatala ang usap-usapan tungkol sa Gamu-gamo, Di-nakikitang Bagon at nilalang sa ilalim ng lungsod. Hindi inuulit ang takip ng iba: pinag-uugnay ang kuwento. Binalak ito bilang huling season para sa nakakakilala ng mga alamat. Isinasara ng takip na Diamante ang siklo pabalik sa unang koleksiyon."
  }
} satisfies Catalog;
export default catalog;
