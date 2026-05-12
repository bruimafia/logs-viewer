#!/bin/bash

# Базовый путь к директории с сервисами
BASE_DIR="/var/www/services"

# Паттерн для поиска директорий сервисов
SERVICE_PATTERN="*-service"

# Имя пользователя, которому нужно дать права на чтение
TARGET_USER="user"

# Проверяем, существует ли базовая директория
if [ ! -d "$BASE_DIR" ]; then
    echo "Ошибка: Директория $BASE_DIR не существует"
    exit 1
fi

# Проверяем, существует ли пользователь
if ! id "$TARGET_USER" &>/dev/null; then
    echo "Ошибка: Пользователь $TARGET_USER не существует"
    exit 1
fi

echo "Поиск сервисов в $BASE_DIR..."
echo ""

# Счетчики для статистики
found_services=0
processed_logs=0
errors=0

# Ищем все директории, соответствующие паттерну
for service_dir in "$BASE_DIR"/$SERVICE_PATTERN; do
    # Проверяем, что это действительно директория
    if [ ! -d "$service_dir" ]; then
        continue
    fi
    
    service_name=$(basename "$service_dir")
    log_file="$service_dir/${service_name}.log"
    
    echo "Обработка сервиса: $service_name"
    found_services=$((found_services + 1))
    
    # Проверяем, существует ли файл лога
    if [ ! -f "$log_file" ]; then
        echo "  Предупреждение: Файл лога $log_file не найден"
        errors=$((errors + 1))
        continue
    fi
    
    # Устанавливаем права на чтение для пользователя user
    # Сохраняем существующие права, добавляя чтение для указанного пользователя
    if setfacl -m "u:$TARGET_USER:r" "$log_file" 2>/dev/null; then
        echo "  ✓ Права на чтение для $TARGET_USER установлены: $log_file"
        processed_logs=$((processed_logs + 1))
    else
        # Если setfacl недоступен, используем chmod (менее гибкий вариант)
        echo "  ACL недоступны, используем chmod..."
        current_perms=$(stat -c "%a" "$log_file" 2>/dev/null || stat -f "%Lp" "$log_file" 2>/dev/null)
        
        # Добавляем права на чтение для others (если setfacl недоступен)
        if chmod o+r "$log_file" 2>/dev/null; then
            echo "  ✓ Права на чтение для всех установлены (обходной вариант): $log_file"
            processed_logs=$((processed_logs + 1))
        else
            echo "  ✗ Ошибка: Не удалось установить права на $log_file"
            errors=$((errors + 1))
        fi
    fi
    
    echo ""
done

# Выводим статистику
echo "========================================="
echo "Статистика выполнения:"
echo "  Найдено сервисов: $found_services"
echo "  Обработано файлов: $processed_logs"
echo "  Ошибок: $errors"
echo "========================================="

if [ $errors -eq 0 ] && [ $found_services -gt 0 ]; then
    echo "✓ Все файлы логов успешно обработаны"
    exit 0
elif [ $found_services -eq 0 ]; then
    echo "⚠ Предупреждение: Сервисы не найдены"
    exit 0
else
    echo "⚠ Завершено с ошибками"
    exit 1
fi