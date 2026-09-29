import type en from './en';
type Catalog = { [K in keyof typeof en]: { [P in keyof (typeof en)[K]]: string } };
const catalog = {
  "c0r0": {
    "name": "Bướm đêm vẽ vội",
    "desc": "Nét phác một lớp, mép sơn còn ướt."
  },
  "c0r1": {
    "name": "Bướm đêm gặp cơn mưa thứ hai",
    "desc": "Nét phác cũ, bóng lên sau trận lụt nữa."
  },
  "c0r2": {
    "name": "Bướm đêm mang cặp",
    "desc": "Tác phẩm nhiều lớp châm biếm xã hội sắc bén."
  },
  "c0r3": {
    "name": "Bướm đêm mang cặp — lớp sơn thứ hai",
    "desc": "Vẽ lại trên bản gốc đã bị xóa."
  },
  "c0r4": {
    "name": "Bướm đêm sau song sắt",
    "desc": "Tác phẩm khiến cả khu tranh luận suốt tuần."
  },
  "c0r5": {
    "name": "Bướm đêm sau song sắt — bản ghi",
    "desc": "Cảnh cũ, nay có ngày tháng và chữ ký."
  },
  "c0r6": {
    "name": "Đêm ba bức tường",
    "desc": "Ba tác phẩm, ba khu phố, cùng một đêm."
  },
  "c0r7": {
    "name": "Đêm ba bức tường — bức tường thứ tư",
    "desc": "Tin về tác phẩm thứ tư chưa được xác nhận."
  },
  "c0r8": {
    "name": "Điện tích nguyên bản",
    "desc": "Nắp đầu tiên để lại bên tác phẩm đầu tiên. Chỉ có một."
  },
  "c1r0": {
    "name": "Lượt thả đầu tiên",
    "desc": "Lần đầu thả mình xuống lòng chảo."
  },
  "c1r1": {
    "name": "Lượt thứ hai",
    "desc": "Cú thả cũ, đáp gọn khi thử lại."
  },
  "c1r2": {
    "name": "Grind mù",
    "desc": "Trượt trên gờ mà không nhìn xuống."
  },
  "c1r3": {
    "name": "Grind mù — thoát gọn",
    "desc": "Đường trượt cũ, cuối cùng đáp thật mượt."
  },
  "c1r4": {
    "name": "Nhảy qua rào",
    "desc": "Vượt hàng rào có người gác chỉ một lần."
  },
  "c1r5": {
    "name": "Nhảy qua rào — trở về",
    "desc": "Nhảy ngược lại giữa ban ngày."
  },
  "c1r6": {
    "name": "Chân xương",
    "desc": "Nghe nói đã trượt cả tuần với hai chân gãy."
  },
  "c1r7": {
    "name": "Chân xương — tái đấu",
    "desc": "Câu chuyện cũ, sau hai lần gãy nữa."
  },
  "c1r8": {
    "name": "540 trên mái nhà",
    "desc": "Không có đoạn phim. Chỉ có nhân chứng."
  },
  "c2r0": {
    "name": "Tag vẽ vội",
    "desc": "Một nét sơn trong phút trước khi tàu chạy."
  },
  "c2r1": {
    "name": "Tag vẽ vội — toa thứ hai",
    "desc": "Cùng người vẽ, cùng đêm, sang toa bên cạnh."
  },
  "c2r2": {
    "name": "Kiệt tác một đêm",
    "desc": "Tác phẩm hoàn chỉnh trước bình minh, không có cơ hội thứ hai."
  },
  "c2r3": {
    "name": "Kiệt tác một đêm — tiếp nối",
    "desc": "Hoàn tất tại ga kế tiếp."
  },
  "c2r4": {
    "name": "Qua ba bang",
    "desc": "Được xác nhận xuất hiện ở ba vùng."
  },
  "c2r5": {
    "name": "Qua ba bang — đi tiếp",
    "desc": "Được nhìn thấy ở nơi xa hơn nữa."
  },
  "c2r6": {
    "name": "Toa tàu vô hình",
    "desc": "Được vẽ trong bãi tàu không ai đáng lẽ vào được."
  },
  "c2r7": {
    "name": "Toa tàu vô hình — chuyến thứ hai",
    "desc": "Nhóm cũ quay lại làm tiếp."
  },
  "c2r8": {
    "name": "Chuyến đi bất tận",
    "desc": "Chưa từng bị xóa. Vẫn lăn bánh sau mười năm."
  },
  "c3r0": {
    "name": "Đôi giày sũng nước",
    "desc": "Phục chế cơ bản, vừa vớt từ cống."
  },
  "c3r1": {
    "name": "Đôi giày sũng nước — trận lụt thứ hai",
    "desc": "Lại được vớt lên và khâu lần nữa."
  },
  "c3r2": {
    "name": "Đường khâu đôi",
    "desc": "Hai sợi song song mang màu đặc trưng của bộ."
  },
  "c3r3": {
    "name": "Đường khâu đôi — lượt thứ ba",
    "desc": "Thêm sợi thứ ba vào mẫu."
  },
  "c3r4": {
    "name": "Lô của một cơn bão",
    "desc": "Khâu trong một cơn bão có tên. Không bao giờ lặp lại."
  },
  "c3r5": {
    "name": "Lô của một cơn bão — đợt hai",
    "desc": "Lô bổ sung từ cùng cơn bão."
  },
  "c3r6": {
    "name": "Đôi cuối của thợ giày",
    "desc": "Một trong những tác phẩm cuối được biết của Mũi Khâu Gỉ."
  },
  "c3r7": {
    "name": "Đôi cuối của thợ giày — tìm thấy muộn",
    "desc": "Xuất hiện nhiều năm sau khi ông biến mất."
  },
  "c3r8": {
    "name": "Đôi đầu tiên",
    "desc": "Đôi giày đầu tiên ông từng phục chế."
  },
  "c4r0": {
    "name": "Scratch đầu tiên",
    "desc": "Kỹ thuật DJ cơ bản, không cầu kỳ."
  },
  "c4r1": {
    "name": "Scratch đầu tiên — diễn lại",
    "desc": "Động tác cũ, lặp lại cho đám đông hò reo hơn."
  },
  "c4r2": {
    "name": "Cối xay trên nhựa đường",
    "desc": "Động tác breaking ít người làm được."
  },
  "c4r3": {
    "name": "Cối xay trên nhựa đường — xoay đôi",
    "desc": "Phiên bản khó hơn của cùng động tác."
  },
  "c4r4": {
    "name": "Hai MC, một mic",
    "desc": "Kỷ vật chiến thắng trận đấu ai cũng nhớ."
  },
  "c4r5": {
    "name": "Hai MC, một mic — tái đấu",
    "desc": "Vẫn hai người, lần này đổi vai."
  },
  "c4r6": {
    "name": "Boombox không ngừng",
    "desc": "Chạy 72 giờ liền bằng điện câu trộm."
  },
  "c4r7": {
    "name": "Boombox không ngừng — đêm thứ hai",
    "desc": "Chiếc máy cũ, chịu thêm một lần nữa."
  },
  "c4r8": {
    "name": "Bữa tiệc đầu khu phố",
    "desc": "Kỷ vật từ bữa tiệc khởi đầu tất cả."
  },
  "c5r0": {
    "name": "Bồ câu trinh sát",
    "desc": "Lính gác trên mái, không hơn."
  },
  "c5r1": {
    "name": "Bồ câu trinh sát — tổ thứ hai",
    "desc": "Chim cũ chiếm mái mới."
  },
  "c5r2": {
    "name": "Mèo chột khu phố",
    "desc": "Người gác không chính thức của khu."
  },
  "c5r3": {
    "name": "Mèo chột khu phố — dấu mới",
    "desc": "Thêm một khu thành lãnh thổ."
  },
  "c5r4": {
    "name": "Biệt đội gấu mèo",
    "desc": "Ba gấu mèo, một thùng rác, phối hợp hoàn hảo."
  },
  "c5r5": {
    "name": "Biệt đội gấu mèo — đột kích lần hai",
    "desc": "Nhóm cũ, chiến lợi phẩm lớn hơn."
  },
  "c5r6": {
    "name": "Nữ hoàng mái nhà",
    "desc": "Mẫu tổ bồ câu chưa ai mô tả trọn vẹn."
  },
  "c5r7": {
    "name": "Nữ hoàng mái nhà — lứa mới",
    "desc": "Tin về đàn con lan truyền."
  },
  "c5r8": {
    "name": "Thứ sống dưới thành phố",
    "desc": "Chưa từng thấy trọn vẹn. Sẽ chẳng bao giờ."
  },
  "c6r0": {
    "name": "Đồng xu đầu",
    "desc": "Lại một đồng xu bỏ vào khe."
  },
  "c6r1": {
    "name": "Đồng xu đầu — tiếp tục",
    "desc": "Người chơi cũ bỏ đồng xu thứ hai."
  },
  "c6r2": {
    "name": "Màn bí mật",
    "desc": "Màn ẩn không ai đáng lẽ tìm ra."
  },
  "c6r3": {
    "name": "Màn bí mật — đường thứ hai",
    "desc": "Cùng màn, vượt theo cách khác."
  },
  "c6r4": {
    "name": "Kỷ lục trên máy hỏng",
    "desc": "Lập trên máy ai cũng bỏ đi."
  },
  "c6r5": {
    "name": "Kỷ lục trên máy hỏng — bị phá",
    "desc": "Người chơi cũ phá kỷ lục của mình."
  },
  "c6r6": {
    "name": "Ba số không",
    "desc": "Điểm được cho là hoàn hảo, vẫn còn tranh cãi."
  },
  "c6r7": {
    "name": "Ba số không — lặp lại",
    "desc": "Tin đồn điểm đó lại được lập."
  },
  "c6r8": {
    "name": "Máy không tồn tại",
    "desc": "Chỉ thấy một lần, mỗi lần ở tầng hầm khác."
  },
  "c7r0": {
    "name": "Tin đồn phố",
    "desc": "Lại một câu chuyện truyền miệng."
  },
  "c7r1": {
    "name": "Tin đồn phố — kể lại",
    "desc": "Câu chuyện cũ, đổi qua mỗi lần kể."
  },
  "c7r2": {
    "name": "Huyền thoại được ghi",
    "desc": "Câu chuyện cuối cùng có người chịu ghi lại."
  },
  "c7r3": {
    "name": "Huyền thoại được ghi — chú thích",
    "desc": "Chuyện cũ, thêm chi tiết mới."
  },
  "c7r4": {
    "name": "Nơi hai chuyện gặp nhau",
    "desc": "Khoảnh khắc huyền thoại hai khu giao nhau."
  },
  "c7r5": {
    "name": "Nơi hai chuyện gặp nhau — khu thứ ba",
    "desc": "Giao điểm cũ, nay thêm văn hóa thứ ba."
  },
  "c7r6": {
    "name": "Đêm thành phố không ngủ",
    "desc": "Tám khu phố, một đêm không tưởng."
  },
  "c7r7": {
    "name": "Đêm thành phố không ngủ — lần nữa?",
    "desc": "Tin đồn chưa xác nhận về đêm thứ hai."
  },
  "c7r8": {
    "name": "Tin đồn đầu tiên",
    "desc": "Huyền thoại được cho đã khởi nguồn cả nền văn hóa."
  },
  "d0": {
    "name": "Bướm đêm",
    "district": "Khu công nghiệp cũ",
    "theme": "Nghệ thuật đường phố bằng khuôn, họa sĩ ẩn danh",
    "history": "Mỗi kỳ trăng mới, hình bướm đêm xuất hiện trên tường kho: mang cặp, sau song sắt hay cầm lá phiếu. Không ai thấy họa sĩ. Đội vệ sinh xóa tranh vào sáng sớm, nhưng nhóm Người Giữ, từng khám phá đô thị, kịp chụp ảnh và thấy một nắp chai dưới mỗi tranh. Đó là khởi đầu của Gutter Caps."
  },
  "d1": {
    "name": "Quỷ nhựa đường",
    "district": "Những hồ bơi cạn",
    "theme": "Trượt ván và BMX",
    "history": "Hạn hán làm cạn hồ bơi, thanh thiếu niên biến lòng hồ bê tông thành sân trượt tự phát. Gia tộc Bê Tông Khô nổi danh qua video rung: trượt với chân gãy, nhảy qua rào bất khả thi. Hồ đã bị phá để xây nhà. Nắp mang tên các cú trượt vẫn là đồng tiền duy nhất có giá trị nơi đây."
  },
  "d2": {
    "name": "Vua đường ray",
    "district": "Bãi tàu hàng",
    "theme": "Graffiti trên tàu",
    "history": "Các nhóm giành toa tàu, không phải bức tường: tàu mang tên họ đến những thành phố xa lạ. Bảo vệ đêm được gọi là Người Quan Sát. Trước kia, dấu vết tranh ở các ga được ghi vào sổ. Nay sổ nằm trên blockchain, không thể sửa quá khứ dù toa tàu đi qua bao nhiêu bãi."
  },
  "d3": {
    "name": "Đế giày cống",
    "district": "Chợ dưới cầu vượt",
    "theme": "Văn hóa giày thể thao, phục chế",
    "history": "Mùa lụt cuốn giày tồn ở chợ vào cống. Thợ lặn vớt lên, thợ giày Mũi Khâu Gỉ hồi sinh chúng. Màu chỉ đặc trưng của ông trở thành dấu điện tích của bộ. Hàng giả luôn ám ảnh người mê giày, nên nguồn gốc trên blockchain đặc biệt quan trọng ở đây."
  },
  "d4": {
    "name": "Khu boombox",
    "district": "Khu phố",
    "theme": "Hip-hop, breaking, đấu MC",
    "history": "Mỗi mùa hè, khu phố mở tiệc dùng điện câu từ đèn đường: họ gọi đó là truyền thống. Vòng breaking tạo huyền thoại, MC đấu vần đến sáng, boombox được truyền như báu vật. Nắp vốn là kỷ vật chiến thắng trước khi ý tưởng lan khắp thành phố."
  },
  "d5": {
    "name": "Thú cống",
    "district": "Cống và ngõ sau",
    "theme": "Truyền thuyết động vật đô thị",
    "history": "Trẻ con kể về vương quốc bí mật: mèo chột làm chủ khu phố, bồ câu bỏ phiếu trên mái, gấu mèo đột kích thùng rác chuẩn như quân đội. Chúng không ác, chỉ là tinh linh phố láu lỉnh. Nắp bộ này nổi từ chính những cống được cho là nhà của chúng."
  },
  "d6": {
    "name": "Tầng hầm pixel",
    "district": "Máy arcade tầng hầm",
    "theme": "Văn hóa arcade cổ điển",
    "history": "Khi tiệm arcade đóng cửa, máy bị bán phế liệu rồi dựng lại trong tầng hầm bí mật. Trò chơi nửa hỏng, nửa tự chế; chẳng ai nhớ tên gốc. Cao thủ khắc tên lên bảng chưa từng xóa làm chủ nơi này. Người săn lỗi phá game cũng được kính nể riêng."
  },
  "d7": {
    "name": "Huyền thoại thành phố",
    "district": "Toàn thành phố",
    "theme": "Bộ tổng hợp: huyền thoại về bảy bộ kia",
    "history": "Nơi đây ghi chuyện về Bướm Đêm, Toa Tàu Vô Hình và thứ dưới thành phố. Bộ không lặp lại nắp khu khác mà nối các câu chuyện. Nó được thiết kế làm mùa cuối cho người đã biết các huyền thoại. Nắp kim cương khép vòng, đưa ta về bộ đầu tiên."
  }
} satisfies Catalog;
export default catalog;
