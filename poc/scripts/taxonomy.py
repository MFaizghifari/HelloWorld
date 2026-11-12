"""Topic taxonomy for KPw BI posts, following Bank Indonesia's mandate areas.
Edit here (and rerun build_topics.py after deleting data/topics.json) to change topics."""

TOPICS = [
    {"id": "stabilitas_nilai_tukar", "label": "Stabilitas nilai tukar",
     "desc": "Kurs/nilai tukar Rupiah, intervensi, pasar valas, lindung nilai (hedging, DNDF, VASTRA), cadangan devisa, pendalaman pasar uang."},
    {"id": "kebijakan_moneter", "label": "Kebijakan moneter & RDG",
     "desc": "Hasil Rapat Dewan Gubernur, BI-Rate, suku bunga, instrumen moneter (SRBI), arah kebijakan."},
    {"id": "inflasi", "label": "Pengendalian inflasi",
     "desc": "Inflasi daerah, TPID, GNPIP, harga pangan, operasi pasar/pasar murah, ketahanan pangan, urban farming."},
    {"id": "sistem_pembayaran", "label": "Sistem pembayaran & QRIS",
     "desc": "QRIS, BI-FAST, transaksi nontunai/digital, elektronifikasi, keamanan transaksi, waspada penipuan digital."},
    {"id": "pengelolaan_rupiah", "label": "Pengelolaan uang Rupiah",
     "desc": "Cinta Bangga Paham Rupiah, ciri keaslian uang, penukaran uang, kas keliling, uang layak edar, Rupiah di daerah 3T."},
    {"id": "stabilitas_sistem_keuangan", "label": "Stabilitas sistem keuangan",
     "desc": "Makroprudensial, kredit/pembiayaan perbankan, inklusi keuangan, pelindungan konsumen."},
    {"id": "umkm", "label": "UMKM & ekonomi kreatif",
     "desc": "Pembinaan/kurasi UMKM, pameran, ekspor UMKM, klaster, wirausaha, kain/kriya daerah."},
    {"id": "ekonomi_syariah", "label": "Ekonomi & keuangan syariah",
     "desc": "Festival ekonomi syariah, industri halal, pesantren, wakaf, keuangan sosial syariah."},
    {"id": "ekonomi_daerah", "label": "Perekonomian daerah",
     "desc": "Kondisi/proyeksi ekonomi regional, diseminasi laporan, investasi, pariwisata, forum dengan pemda dan pelaku usaha."},
    {"id": "edukasi_kebanksentralan", "label": "Edukasi & GenBI",
     "desc": "Edukasi kebanksentralan, literasi ekonomi/keuangan, GenBI, beasiswa, kunjungan ke kantor BI, kuis edukasi."},
    {"id": "sosial_lingkungan", "label": "Sosial & lingkungan (PSBI)",
     "desc": "Program Sosial BI, bantuan, ekonomi hijau, lingkungan, kesehatan, pendidikan masyarakat."},
    {"id": "kelembagaan", "label": "Kelembagaan & seremonial",
     "desc": "Ucapan hari besar, peringatan, HUT, pelantikan, audiensi, olahraga/kegiatan internal, informasi layanan kantor."},
]
TOPIC_IDS = [t["id"] for t in TOPICS]
