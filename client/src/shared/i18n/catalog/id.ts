import type en from './en';
type Catalog = { [K in keyof typeof en]: { [P in keyof (typeof en)[K]]: string } };
const catalog = {
  "c0r0": {
    "name": "Ngengat kilat",
    "desc": "Sketsa kasar satu lapis, tepinya masih basah."
  },
  "c0r1": {
    "name": "Ngengat dalam hujan kedua",
    "desc": "Sketsa yang sama, mengilap oleh banjir berikutnya."
  },
  "c0r2": {
    "name": "Ngengat membawa tas",
    "desc": "Karya berlapis dengan sindiran sosial tajam."
  },
  "c0r3": {
    "name": "Ngengat membawa tas — lapisan kedua",
    "desc": "Dicat ulang di atas karya asli yang dihapus."
  },
  "c0r4": {
    "name": "Ngengat di balik jeruji",
    "desc": "Karya yang diperdebatkan satu blok selama seminggu."
  },
  "c0r5": {
    "name": "Ngengat di balik jeruji — catatan",
    "desc": "Adegan yang sama, kini bertanggal dan ditandatangani."
  },
  "c0r6": {
    "name": "Malam tiga tembok",
    "desc": "Tiga karya, tiga distrik, satu malam."
  },
  "c0r7": {
    "name": "Malam tiga tembok — tembok keempat",
    "desc": "Penampakan keempat yang belum terkonfirmasi."
  },
  "c0r8": {
    "name": "Muatan sejati",
    "desc": "Tutup pertama di karya pertama. Hanya ada satu."
  },
  "c1r0": {
    "name": "Luncuran pertama",
    "desc": "Pertama kali meluncur ke dalam kolam skate."
  },
  "c1r1": {
    "name": "Percobaan kedua",
    "desc": "Luncuran sama, berhasil pada percobaan ulang."
  },
  "c1r2": {
    "name": "Grind buta",
    "desc": "Grind tanpa pernah melihat ke bawah."
  },
  "c1r3": {
    "name": "Grind buta — akhir mulus",
    "desc": "Jalur yang sama, akhirnya selesai mulus."
  },
  "c1r4": {
    "name": "Lompatan pagar",
    "desc": "Melewati pagar yang dijaga dalam sekali lompat."
  },
  "c1r5": {
    "name": "Lompatan pagar — kembali",
    "desc": "Lompatan balik yang sama, di siang bolong."
  },
  "c1r6": {
    "name": "Kaki tulang",
    "desc": "Konon meluncur seminggu dengan kedua kaki patah."
  },
  "c1r7": {
    "name": "Kaki tulang — tanding ulang",
    "desc": "Cerita yang sama, dua patah tulang kemudian."
  },
  "c1r8": {
    "name": "540 di atap",
    "desc": "Tidak ada rekaman. Hanya saksi."
  },
  "c2r0": {
    "name": "Tag kilat",
    "desc": "Satu garis disemprot semenit sebelum berangkat."
  },
  "c2r1": {
    "name": "Tag kilat — gerbong kedua",
    "desc": "Seniman sama, malam sama, gerbong sebelah."
  },
  "c2r2": {
    "name": "Mahakarya semalam",
    "desc": "Karya lengkap sebelum fajar, tanpa kesempatan kedua."
  },
  "c2r3": {
    "name": "Mahakarya semalam — lanjutan",
    "desc": "Diselesaikan di perhentian berikutnya."
  },
  "c2r4": {
    "name": "Melintasi tiga negara bagian",
    "desc": "Penampakan terkonfirmasi di tiga wilayah."
  },
  "c2r5": {
    "name": "Melintasi tiga negara bagian — terus berjalan",
    "desc": "Terlihat makin jauh."
  },
  "c2r6": {
    "name": "Gerbong tak terlihat",
    "desc": "Dilukis di depo yang seharusnya tak bisa dimasuki."
  },
  "c2r7": {
    "name": "Gerbong tak terlihat — perjalanan kedua",
    "desc": "Kru yang sama kembali lagi."
  },
  "c2r8": {
    "name": "Perjalanan tanpa akhir",
    "desc": "Tak pernah dihapus. Masih berjalan setelah sepuluh tahun."
  },
  "c3r0": {
    "name": "Sepasang sepatu basah",
    "desc": "Restorasi sederhana, langsung dari selokan."
  },
  "c3r1": {
    "name": "Sepasang sepatu basah — banjir kedua",
    "desc": "Ditemukan lagi, dijahit ulang."
  },
  "c3r2": {
    "name": "Jahitan ganda",
    "desc": "Dua benang sejajar dengan warna khas koleksi."
  },
  "c3r3": {
    "name": "Jahitan ganda — lintasan ketiga",
    "desc": "Benang ketiga ditambahkan pada pola."
  },
  "c3r4": {
    "name": "Batch satu badai",
    "desc": "Dijahit saat satu badai bernama. Tak pernah diulang."
  },
  "c3r5": {
    "name": "Batch satu badai — gelombang kedua",
    "desc": "Batch tambahan dari badai yang sama."
  },
  "c3r6": {
    "name": "Pasangan terakhir si tukang sepatu",
    "desc": "Salah satu karya terakhir Jahitan Karat yang diketahui."
  },
  "c3r7": {
    "name": "Pasangan terakhir si tukang sepatu — temuan terlambat",
    "desc": "Muncul bertahun-tahun setelah ia menghilang."
  },
  "c3r8": {
    "name": "Pasangan pertama",
    "desc": "Pasangan pertama yang pernah ia pulihkan."
  },
  "c4r0": {
    "name": "Scratch pertama",
    "desc": "Gerakan DJ dasar, tidak istimewa."
  },
  "c4r1": {
    "name": "Scratch pertama — encore",
    "desc": "Gerakan sama, diulang untuk penonton lebih riuh."
  },
  "c4r2": {
    "name": "Windmill di aspal",
    "desc": "Gerakan breaking yang sulit dilakukan kebanyakan orang."
  },
  "c4r3": {
    "name": "Windmill di aspal — putaran ganda",
    "desc": "Versi lebih sulit dari gerakan yang sama."
  },
  "c4r4": {
    "name": "Dua MC, satu mikrofon",
    "desc": "Token kemenangan laga yang diingat semua orang."
  },
  "c4r5": {
    "name": "Dua MC, satu mikrofon — tanding ulang",
    "desc": "Dua orang sama, kini bertukar peran."
  },
  "c4r6": {
    "name": "Boombox tanpa henti",
    "desc": "Menyala 72 jam berturut-turut dengan listrik curian."
  },
  "c4r7": {
    "name": "Boombox tanpa henti — malam kedua",
    "desc": "Perangkat sama bertahan sekali lagi."
  },
  "c4r8": {
    "name": "Pesta pertama blok",
    "desc": "Token dari pesta yang memulai semuanya."
  },
  "c5r0": {
    "name": "Merpati pengintai",
    "desc": "Penjaga atap, tidak lebih."
  },
  "c5r1": {
    "name": "Merpati pengintai — sarang kedua",
    "desc": "Burung sama menguasai atap baru."
  },
  "c5r2": {
    "name": "Kucing bermata satu",
    "desc": "Penjaga lingkungan tidak resmi."
  },
  "c5r3": {
    "name": "Kucing bermata satu — tanda baru",
    "desc": "Satu blok lagi menjadi wilayahnya."
  },
  "c5r4": {
    "name": "Regu rakun",
    "desc": "Tiga rakun, satu tempat sampah, waktu sempurna."
  },
  "c5r5": {
    "name": "Regu rakun — serbuan kedua",
    "desc": "Kru sama, jarahan lebih besar."
  },
  "c5r6": {
    "name": "Ratu atap",
    "desc": "Induk merpati yang belum pernah digambarkan sepenuhnya."
  },
  "c5r7": {
    "name": "Ratu atap — anak baru",
    "desc": "Kabar keturunannya menyebar."
  },
  "c5r8": {
    "name": "Makhluk di bawah kota",
    "desc": "Tak pernah terlihat utuh. Tak akan pernah."
  },
  "c6r0": {
    "name": "Koin pertama",
    "desc": "Satu koin lagi masuk ke mesin."
  },
  "c6r1": {
    "name": "Koin pertama — lanjutkan",
    "desc": "Pemain sama memasukkan koin kedua."
  },
  "c6r2": {
    "name": "Level rahasia",
    "desc": "Tahap tersembunyi yang seharusnya tidak ditemukan."
  },
  "c6r3": {
    "name": "Level rahasia — jalur kedua",
    "desc": "Level sama, diselesaikan lewat cara berbeda."
  },
  "c6r4": {
    "name": "Rekor di mesin rusak",
    "desc": "Dibuat di mesin yang sudah dianggap tak berguna."
  },
  "c6r5": {
    "name": "Rekor di mesin rusak — terpecahkan",
    "desc": "Pemain sama memecahkan rekornya sendiri."
  },
  "c6r6": {
    "name": "Nol tiga kali",
    "desc": "Skor yang konon sempurna, masih diperdebatkan."
  },
  "c6r7": {
    "name": "Nol tiga kali — terulang",
    "desc": "Rumor bahwa skor sama dicapai lagi."
  },
  "c6r8": {
    "name": "Mesin yang tidak ada",
    "desc": "Terlihat sekali, selalu di ruang bawah tanah berbeda."
  },
  "c7r0": {
    "name": "Rumor jalanan",
    "desc": "Satu cerita lagi yang beredar."
  },
  "c7r1": {
    "name": "Rumor jalanan — diceritakan ulang",
    "desc": "Cerita sama, berubah saat dikisahkan ulang."
  },
  "c7r2": {
    "name": "Legenda tertulis",
    "desc": "Cerita yang akhirnya dicatat seseorang."
  },
  "c7r3": {
    "name": "Legenda tertulis — catatan kaki",
    "desc": "Kisah sama dengan detail baru."
  },
  "c7r4": {
    "name": "Saat dua kisah bertemu",
    "desc": "Momen pertemuan legenda dua distrik."
  },
  "c7r5": {
    "name": "Saat dua kisah bertemu — distrik ketiga",
    "desc": "Pertemuan sama, kini melibatkan budaya ketiga."
  },
  "c7r6": {
    "name": "Malam saat kota tak tidur",
    "desc": "Delapan distrik, satu malam mustahil."
  },
  "c7r7": {
    "name": "Malam saat kota tak tidur — lagi?",
    "desc": "Rumor belum terkonfirmasi tentang malam kedua."
  },
  "c7r8": {
    "name": "Rumor pertama",
    "desc": "Mitos yang konon memulai seluruh budaya ini."
  },
  "d0": {
    "name": "Ngengat malam",
    "district": "Kawasan industri tua",
    "theme": "Seni jalanan stensil, pelukis anonim",
    "history": "Setiap bulan baru, gambar ngengat muncul di gudang: membawa tas, di balik jeruji, atau memegang surat suara. Senimannya tak pernah terlihat. Petugas menghapusnya saat pagi, tetapi para Penjaga, mantan penjelajah kota, memotretnya dan menemukan tutup botol di bawah setiap karya. Di sinilah kisah tutup bermuatan Gutter Caps dimulai."
  },
  "d1": {
    "name": "Iblis aspal",
    "district": "Kolam-kolam kering",
    "theme": "Skate dan BMX",
    "history": "Kekeringan mengosongkan kolam, lalu remaja menjadikannya taman skate liar. Klan Beton Kering dikenal lewat video goyah: meluncur dengan kaki patah, melompati pagar mustahil. Kolam sudah dihancurkan untuk apartemen. Tutup dengan nama trik tetap menjadi satu-satunya mata uang yang dihargai di sini."
  },
  "d2": {
    "name": "Raja rel",
    "district": "Depo kereta barang",
    "theme": "Grafiti kereta",
    "history": "Kru memperebutkan gerbong, bukan tembok: kereta membawa nama mereka ke kota yang belum dikunjungi. Penjaga malam disebut Pengamat. Dahulu, penampakan karya di stasiun dicatat dalam buku. Kini catatan itu ada di blockchain dan tak bisa diubah, sejauh apa pun gerbong berjalan."
  },
  "d3": {
    "name": "Sol selokan",
    "district": "Pasar bawah jalan layang",
    "theme": "Budaya sepatu, restorasi",
    "history": "Banjir menghanyutkan sepatu tak terjual ke selokan. Penyelam mengambilnya, lalu tukang sepatu Jahitan Karat memulihkannya. Warna benang khasnya menjadi tanda muatan koleksi ini. Barang palsu selalu menghantui pencinta sepatu, sehingga bukti asal-usul di blockchain sangat berarti di sini."
  },
  "d4": {
    "name": "Blok boombox",
    "district": "Blok",
    "theme": "Hip-hop, breaking, adu MC",
    "history": "Setiap musim panas ada pesta dengan listrik dari lampu jalan: bukan kejahatan, melainkan tradisi. Lingkaran breaking melahirkan legenda, MC berbalas rima hingga fajar, boombox diwariskan seperti pusaka. Tutup awalnya token pemenang laga, jauh sebelum idenya menyebar ke seluruh kota."
  },
  "d5": {
    "name": "Satwa selokan",
    "district": "Selokan dan gang belakang",
    "theme": "Cerita rakyat satwa kota",
    "history": "Anak-anak bercerita tentang kerajaan tersembunyi: kucing bermata satu menguasai blok, merpati memilih di atap, rakun menyerbu sampah dengan ketepatan militer. Mereka bukan penjahat, melainkan roh jalanan yang licik. Tutup koleksi ini muncul dari selokan yang konon menjadi rumah mereka."
  },
  "d6": {
    "name": "Ruang bawah tanah pixel",
    "district": "Arkade bawah tanah",
    "theme": "Budaya arkade retro",
    "history": "Saat arkade tutup, mesin dijual sebagai rongsokan lalu dibangun ulang di ruang bawah tanah rahasia. Gamenya setengah rusak, setengah diciptakan ulang; nama asli dilupakan. Pemegang rekor mengukir inisial di papan yang tak pernah dihapus. Pemburu bug perusak game juga mendapat penghormatan tersendiri."
  },
  "d7": {
    "name": "Mitos kota",
    "district": "Seluruh kota",
    "theme": "Koleksi penghubung: legenda tujuh koleksi lain",
    "history": "Di sini dicatat rumor Ngengat, Gerbong Tak Terlihat, dan makhluk bawah kota. Koleksi ini tidak mengulang tutup lain, melainkan mempertemukan kisahnya. Dirancang sebagai musim terakhir bagi pemain yang mengenal semua legenda. Tutup Berliannya menutup lingkaran, kembali ke koleksi pertama."
  }
} satisfies Catalog;
export default catalog;
