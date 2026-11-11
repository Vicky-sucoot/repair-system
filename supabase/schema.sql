-- 報修登記系統初始結構；本檔僅供審閱，須由專案管理者另行決定是否執行。
-- 文字長度為本次設計上限，正式上線前應確認需求；以字元數計算。
BEGIN;

-- 建立資料表：識別碼與建立時間由資料庫產生，所有業務欄位皆必填。
CREATE TABLE public.repair_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at timestamptz NOT NULL DEFAULT now(),
    reporter_name text NOT NULL,
    location text NOT NULL,
    category text NOT NULL,
    description text NOT NULL,
    urgency text NOT NULL DEFAULT '中',
    status text NOT NULL DEFAULT '待處理',

    -- CHECK：拒絕空白文字，限制姓名、地點與描述長度。
    CONSTRAINT repair_requests_reporter_name_check
        CHECK (char_length(reporter_name) BETWEEN 1 AND 100 AND reporter_name ~ '[^[:space:]]'),
    CONSTRAINT repair_requests_location_check
        CHECK (char_length(location) BETWEEN 1 AND 200 AND location ~ '[^[:space:]]'),
    CONSTRAINT repair_requests_description_check
        CHECK (char_length(description) BETWEEN 1 AND 2000 AND description ~ '[^[:space:]]'),

    -- CHECK：列舉值同時限制內容與最大長度，禁止任意類別或狀態。
    CONSTRAINT repair_requests_category_check
        CHECK (category IN ('設備', '網路', '環境', '其他') AND char_length(category) <= 2),
    CONSTRAINT repair_requests_urgency_check
        CHECK (urgency IN ('低', '中', '高') AND char_length(urgency) <= 1),
    CONSTRAINT repair_requests_status_check
        CHECK (status IN ('待處理', '處理中', '已完成') AND char_length(status) <= 3)
);

-- GRANT：清除可能由預設權限帶入的資料表存取，只開放匿名角色需要的權限。
-- 本流程僅支援 anon；authenticated 不取得此表權限。
REVOKE ALL PRIVILEGES ON TABLE public.repair_requests FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA public TO anon;
GRANT SELECT ON TABLE public.repair_requests TO anon;
-- 僅可提交下列欄位；id、created_at、status 必須使用資料庫預設值。
GRANT INSERT (reporter_name, location, category, description, urgency)
    ON TABLE public.repair_requests TO anon;
-- 不授予 UPDATE、DELETE 或 TRUNCATE；uuid 預設值無須序列權限。

-- RLS：即使取得資料表權限，仍須通過資料列政策。
ALTER TABLE public.repair_requests ENABLE ROW LEVEL SECURITY;

-- RLS 讀取：匿名使用者可以讀取全部報修清單。
CREATE POLICY repair_requests_anon_select
    ON public.repair_requests
    FOR SELECT
    TO anon
    USING (true);

-- RLS 新增：新增資料的初始狀態只能為待處理。
-- 即使未來調整欄位授權，仍不得以其他狀態新增；不建立修改或刪除政策。
CREATE POLICY repair_requests_anon_insert
    ON public.repair_requests
    FOR INSERT
    TO anon
    WITH CHECK (status = '待處理');

-- 所有結構與權限設定以同一交易完成；重複執行會因資料表已存在而失敗。
COMMIT;
