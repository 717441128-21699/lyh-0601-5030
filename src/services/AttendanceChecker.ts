import {
  AttendanceResult,
  AttendanceStatus,
  PunchRecord,
  WorkSchedule,
  LeaveRequest,
  OvertimeRecord,
} from '../types';
import { WorkdayChecker } from './WorkdayChecker';
import { ShiftCalculator } from './ShiftCalculator';
import {
  parseDateTime,
  timeToMinutes,
  createDateTime,
  diffMinutes,
  roundHours,
  getDatePart,
  formatDate,
} from '../utils/dateUtils';

export interface AttendanceCheckParams {
  schedule: WorkSchedule;
  punch?: PunchRecord;
  leaves: LeaveRequest[];
  overtimes: OvertimeRecord[];
}

export class AttendanceChecker {
  private workdayChecker: WorkdayChecker;
  private shiftCalculator: ShiftCalculator;

  constructor(workdayChecker: WorkdayChecker, shiftCalculator: ShiftCalculator) {
    this.workdayChecker = workdayChecker;
    this.shiftCalculator = shiftCalculator;
  }

  checkAttendance(params: AttendanceCheckParams): AttendanceResult {
    const { schedule, punch, leaves, overtimes } = params;
    const date = schedule.date;
    const anomalyReasons: string[] = [];
    let status: AttendanceStatus;
    let lateMinutes = 0;
    let earlyLeaveMinutes = 0;
    let workHours = 0;
    let overtimeHours = 0;
    let leaveHours = 0;

    if (schedule.isRestDay || schedule.isHoliday) {
      if (overtimes.length > 0) {
        status = 'overtime';
        overtimeHours = this.calculateOvertimeHours(date, overtimes);
      } else if (schedule.isHoliday) {
        status = 'rest_day';
        anomalyReasons.push(`节假日：${schedule.holidayName || '法定节假日'}`);
      } else {
        status = 'rest_day';
      }
    } else {
      status = 'normal';

      const approvedLeaves = leaves.filter(
        (l) => l.status === 'approved' || l.status === 'pending'
      );

      if (approvedLeaves.length > 0) {
        leaveHours = this.calculateLeaveHours(date, approvedLeaves, schedule);
        if (leaveHours > 0) {
          status = 'leave';
        }
      }

      const businessTripLeaves = leaves.filter(
        (l) => l.leaveTypeCode === 'business_trip' && (l.status === 'approved' || l.status === 'pending')
      );
      if (businessTripLeaves.length > 0) {
        const tripHours = this.calculateLeaveHours(date, businessTripLeaves, schedule);
        if (tripHours > 0) {
          status = 'business_trip';
          leaveHours = tripHours;
        }
      }

      if (schedule.shift && punch) {
        const lateResult = this.calculateLateMinutes(punch, schedule);
        lateMinutes = lateResult.minutes;
        if (lateResult.isLate) {
          status = 'late';
          anomalyReasons.push(`迟到 ${lateMinutes} 分钟`);
        }

        const earlyResult = this.calculateEarlyLeaveMinutes(punch, schedule);
        earlyLeaveMinutes = earlyResult.minutes;
        if (earlyResult.isEarlyLeave) {
          status = status === 'late' ? status : 'early_leave';
          anomalyReasons.push(`早退 ${earlyLeaveMinutes} 分钟`);
        }

        workHours = this.calculateActualWorkHours(punch, schedule);
      }

      if (schedule.shift && !punch) {
        if (leaveHours === 0) {
          status = 'absent';
          anomalyReasons.push('未打卡');
        }
      }

      if (schedule.shift && punch) {
        if (!punch.checkIn) {
          anomalyReasons.push('缺上班打卡');
          if (status === 'normal') status = 'absent';
        }
        if (!punch.checkOut) {
          anomalyReasons.push('缺下班打卡');
          if (status === 'normal') status = 'absent';
        }
      }

      if (overtimes.length > 0 && schedule.shift && punch) {
        const dayOvertime = this.calculateOvertimeHours(date, overtimes, schedule.shift);
        if (dayOvertime > 0) {
          overtimeHours = dayOvertime;
          if (status === 'normal') {
            status = 'overtime';
          }
        }
      }
    }

    if (!schedule.shift && !schedule.isRestDay && !schedule.isHoliday) {
      anomalyReasons.push('当日无排班');
    }

    const isNormal =
      status === 'normal' ||
      status === 'overtime' ||
      status === 'leave' ||
      status === 'business_trip' ||
      status === 'rest_day';

    return {
      employeeId: schedule.employeeId,
      date,
      status,
      checkIn: punch?.checkIn,
      checkOut: punch?.checkOut,
      shiftStartTime: schedule.shift?.startTime,
      shiftEndTime: schedule.shift?.endTime,
      lateMinutes,
      earlyLeaveMinutes,
      workHours: roundHours(workHours),
      overtimeHours: roundHours(overtimeHours),
      leaveHours: roundHours(leaveHours),
      anomalyReasons,
      isNormal,
    };
  }

  private calculateLateMinutes(
    punch: PunchRecord,
    schedule: WorkSchedule
  ): { minutes: number; isLate: boolean } {
    if (!punch.checkIn || !schedule.shift) {
      return { minutes: 0, isLate: false };
    }

    const graceMinutes = schedule.shift.lateGraceMinutes || 0;
    const checkInMinutes = timeToMinutes(punch.checkIn);
    const shiftStartMinutes = timeToMinutes(schedule.shift.startTime);

    let diff = checkInMinutes - shiftStartMinutes;
    if (diff < 0) diff = 0;

    const isLate = diff > graceMinutes;
    const actualMinutes = isLate ? diff - graceMinutes : 0;

    return { minutes: actualMinutes, isLate };
  }

  private calculateEarlyLeaveMinutes(
    punch: PunchRecord,
    schedule: WorkSchedule
  ): { minutes: number; isEarlyLeave: boolean } {
    if (!punch.checkOut || !schedule.shift) {
      return { minutes: 0, isEarlyLeave: false };
    }

    const graceMinutes = schedule.shift.earlyLeaveGraceMinutes || 0;
    const checkOutMinutes = timeToMinutes(punch.checkOut);
    let shiftEndMinutes = timeToMinutes(schedule.shift.endTime);

    if (shiftEndMinutes <= timeToMinutes(schedule.shift.startTime)) {
      shiftEndMinutes += 24 * 60;
      if (checkOutMinutes <= timeToMinutes(schedule.shift.startTime)) {
        checkOutMinutes + 0;
      }
    }

    let actualCheckOut = checkOutMinutes;
    if (shiftEndMinutes > 24 * 60 && checkOutMinutes <= timeToMinutes(schedule.shift.startTime)) {
      actualCheckOut = checkOutMinutes + 24 * 60;
    }

    let diff = shiftEndMinutes - actualCheckOut;
    if (diff < 0) diff = 0;

    const isEarlyLeave = diff > graceMinutes;
    const actualMinutes = isEarlyLeave ? diff - graceMinutes : 0;

    return { minutes: actualMinutes, isEarlyLeave };
  }

  private calculateActualWorkHours(
    punch: PunchRecord,
    schedule: WorkSchedule
  ): number {
    if (!punch.checkIn || !punch.checkOut || !schedule.shift) {
      return 0;
    }

    const shiftHours = this.shiftCalculator.calculateShiftHours(schedule.shift);
    const deduction = this.shiftCalculator.calculateLeaveDeductionHours(
      schedule.shift,
      schedule.date,
      createDateTime(schedule.date, punch.checkIn),
      createDateTime(schedule.date, punch.checkOut)
    );

    return Math.min(deduction.hours, shiftHours.workHours);
  }

  private calculateLeaveHours(
    date: string,
    leaves: LeaveRequest[],
    schedule: WorkSchedule
  ): number {
    let totalHours = 0;

    for (const leave of leaves) {
      const leaveStartDate = getDatePart(leave.startTime);
      const leaveEndDate = getDatePart(leave.endTime);

      if (date < leaveStartDate || date > leaveEndDate) continue;

      if (schedule.shift) {
        const deduction = this.shiftCalculator.calculateLeaveDeductionHours(
          schedule.shift,
          date,
          leave.startTime,
          leave.endTime
        );
        totalHours += deduction.hours;
      } else {
        const leaveStart = parseDateTime(leave.startTime);
        const leaveEnd = parseDateTime(leave.endTime);
        const dayStart = parseDateTime(createDateTime(date, '00:00'));
        const dayEnd = parseDateTime(createDateTime(date, '23:59:59'));

        const actualStart = leaveStart > dayStart ? leaveStart : dayStart;
        const actualEnd = leaveEnd < dayEnd ? leaveEnd : dayEnd;

        if (actualEnd > actualStart) {
          totalHours += diffMinutes(
            formatDate(actualStart) + ' ' + actualStart.toTimeString().slice(0, 8),
            formatDate(actualEnd) + ' ' + actualEnd.toTimeString().slice(0, 8)
          ) / 60;
        }
      }
    }

    return totalHours;
  }

  private calculateOvertimeHours(
    date: string,
    overtimes: OvertimeRecord[],
    shift?: WorkSchedule['shift']
  ): number {
    let totalHours = 0;

    for (const ot of overtimes) {
      if (ot.date !== date || !ot.approved) continue;

      if (shift) {
        const shiftEnd = timeToMinutes(shift.endTime);
        const otStart = timeToMinutes(ot.startTime);
        const otEnd = timeToMinutes(ot.endTime);

        let actualStart = otStart > shiftEnd ? otStart : shiftEnd;
        let actualEnd = otEnd;

        if (actualEnd > actualStart) {
          totalHours += (actualEnd - actualStart) / 60;
        }
      } else {
        totalHours += ot.durationHours;
      }
    }

    return totalHours;
  }
}
