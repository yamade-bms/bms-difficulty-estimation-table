var allData = []; // 全データを保持
var globalMark = ""; // 難易度記号を保持
var groupedData = {}; // レベルごとにグループ化したデータ

function initTable() {
    // データ読み込み処理を関数化
    function loadTableData(forceReload) {
        var $loadBtn = $("#btnLoadData");
        var $reloadBtn = $("#btnReload");
        
        $loadBtn.prop("disabled", true).text("読み込み中...");
        $reloadBtn.prop("disabled", true).text("通信中...");

        var headerUrl = $("meta[name=bmstable]").attr("content");
        // 強制リロード時はURL末尾にタイムスタンプを付与しキャッシュを回避
        if (forceReload) {
            headerUrl += "?t=" + new Date().getTime();
        }

        $.getJSON(headerUrl, function (header) {
            globalMark = header.symbol;
            var dataUrl = header.data_url;
            if (forceReload) {
                dataUrl += "?t=" + new Date().getTime();
            }

            $.getJSON(dataUrl, function (information) {
                allData = information;

                // 検索窓に文字が入力されている状態での再読み込みを考慮
                var keyword = $("#searchInput").val().toLowerCase();
                if (keyword) {
                    var filteredData = allData.filter(function(item) {
                        var title = (item.title || "").toLowerCase();
                        var artist = (item.artist || "").toLowerCase();
                        return title.includes(keyword) || artist.includes(keyword);
                    });
                    renderHeaders(filteredData);
                } else {
                    renderHeaders(allData);
                }

                $("#loadContainer").hide();
                $("#controlsContainer").removeClass("d-none");
                
                $loadBtn.prop("disabled", false).text("難易度表を読み込む");
                $reloadBtn.prop("disabled", false).text("再読み込み");
            }).fail(function() {
                alert("データ(score.json)の取得に失敗しました。");
                $loadBtn.prop("disabled", false).text("難易度表を読み込む");
                $reloadBtn.prop("disabled", false).text("再読み込み");
            });
        }).fail(function() {
            alert("ヘッダ情報の取得に失敗しました。");
            $loadBtn.prop("disabled", false).text("難易度表を読み込む");
            $reloadBtn.prop("disabled", false).text("再読み込み");
        });
    }

    // 読み込みボタンのイベント
    $("#btnLoadData").on("click", function() {
        loadTableData(false);
    });

    // 再読み込みボタンのイベント（キャッシュリセット）
    $("#btnReload").on("click", function() {
        loadTableData(true);
    });

    // 検索窓の入力イベント
    $("#searchInput").on("input", function() {
        var keyword = $(this).val().toLowerCase();

        if (!keyword) {
            renderHeaders(allData);
            return;
        }

        // キーワードでフィルタリング
        var filteredData = allData.filter(function(item) {
            var title = (item.title || "").toLowerCase();
            var artist = (item.artist || "").toLowerCase();
            return title.includes(keyword) || artist.includes(keyword);
        });

        renderHeaders(filteredData);
    });

    // --- 検索窓でEnterを押した時のイベント ---
    $("#searchInput").on("keydown", function(e) {
        // IME入力中（変換確定のためのEnterなど）は処理を中断
        if (e.isComposing) {
            return;
        }

        if (e.key === "Enter") {
            e.preventDefault(); // デフォルト動作をキャンセル
            $("#btnExpandAll").trigger("click");
        }
    });

    // すべて展開ボタン
    $("#btnExpandAll").on("click", function() {
        // まだ展開されていないヘッダのみを対象にクリックイベントを発火させる
        $("#table_int .level-header:not(.expanded)").each(function() {
            $(this).trigger("click");
        });
    });

    // すべて閉じるボタン
    $("#btnCollapseAll").on("click", function() {
        // 展開済みの状態をリセットし、コンテンツを一括削除する（高速処理）
        $("#table_int .level-header").removeClass("expanded");
        $("#table_int .level-content").empty();
    });

    // ヘッダクリック時の展開/折りたたみ処理（イベント委譲）
    $("#table_int").on("click", ".level-header", function() {
        var $this = $(this);
        var level = $this.data("level");
        // クリックされたヘッダの次のtbody（データ格納用）を取得
        var $contentBody = $this.closest("tbody").next(".level-content");

        if ($this.hasClass("expanded")) {
            // tbodyの中身を一度に空にする（超高速）
            $contentBody.empty();
            $this.removeClass("expanded");

            var count = groupedData[level].length;
            $this.find("b").text(globalMark + level + " (" + count + ")");
        } else {
            var items = groupedData[level];
            var rowsHtml = [];

            for (var i = 0; i < items.length; i++) {
                var item = items[i];
                var subtitle = (item.subtitle != null && item.subtitle !== "") ? " " + item.subtitle : "";
                var subartist = (item.subartist != null && item.subartist !== "") ? " " + item.subartist : "";

                rowsHtml.push(
                    "<tr>" +
                    "<td>" + globalMark + level + "</td>" +
                    "<td><a href='http://www.dream-pro.info/~lavalse/LR2IR/search.cgi?mode=ranking&bmsmd5=" + item.md5 + "' target='_blank'>" + item.title + subtitle + "</a></td>" +
                    "<td>" + item.artist + subartist + "</td>" +
                    "<td><a href='http://mocha-repository.info/song.php?sha256=" + item.sha256 + "' target='_blank'><i class='bi bi-box-arrow-up-right'></i></a></td>" +
                    "<td>" + item.comment + "</td>" +
                    "</tr>"
                );
            }

            // tbodyの中に一括でHTMLを流し込む
            $contentBody.html(rowsHtml.join(""));
            $this.addClass("expanded");

            var count = groupedData[level].length;
            $this.find("b").text(globalMark + level + " (" + count + ")");
        }
    });
}


// レベルごとのヘッダを描画する関数
function renderHeaders(dataToRender) {
    groupedData = {};

    for (var i = 0; i < dataToRender.length; i++) {
        var lv = dataToRender[i].level;
        if (!groupedData[lv]) {
            groupedData[lv] = [];
        }
        groupedData[lv].push(dataToRender[i]);
    }

    var obj = $("#table_int");
    var htmlParts = ["<thead class='table-dark'><tr><th style='width: 10%;'>Level</th><th style='width: 45%;'>Title</th><th style='width: 30%;'>Artist</th><th style='width: 5%;'>mocha</th><th style='width: 10%;'>Comment</th></tr></thead>"];

    for (var level in groupedData) {
        var count = groupedData[level].length;
        // ヘッダ用のtbodyと、データ用の空tbodyをセットで作成する
        htmlParts.push(
            "<tbody>" +
            "<tr class='table-dark level-header' data-level='" + level + "' style='cursor:pointer; text-align:center;'>" +
            "<td colspan='5'><b>" + globalMark + level + " (" + count + ")</b></td>" +
            "</tr>" +
            "</tbody>" +
            "<tbody class='level-content' data-level='" + level + "'></tbody>"
        );
    }

    obj.html(htmlParts.join(""));
}

initTable();
